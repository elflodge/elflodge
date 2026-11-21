import { isDeepStrictEqual, transferableAbortController } from "node:util";

import {
  awaitWithContext,
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  Models,
  Provider,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { ModelRuntime, ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
  LiveDoc,
  type ConversationId,
  type Harness,
  type TaskId,
} from "@earendil-works/pi-durable";
import type { BirpcReturn } from "birpc";

import type { HostFunctions, ProviderSettings, WorkerFunctions } from "./protocol.ts";

type Runtime = Pick<
  ModelRuntime,
  | "registerProvider"
  | "unregisterProvider"
  | "getRegisteredProviderConfig"
  | "getRegisteredNativeProvider"
  | "registerNativeProvider"
>;

function supportsProviders(models: Models): models is Models & Runtime {
  return (
    "registerProvider" in models &&
    typeof models.registerProvider === "function" &&
    "unregisterProvider" in models &&
    typeof models.unregisterProvider === "function" &&
    "getRegisteredProviderConfig" in models &&
    typeof models.getRegisteredProviderConfig === "function" &&
    "getRegisteredNativeProvider" in models &&
    typeof models.getRegisteredNativeProvider === "function" &&
    "registerNativeProvider" in models &&
    typeof models.registerNativeProvider === "function"
  );
}

type WorkerRpc = BirpcReturn<WorkerFunctions, HostFunctions>;
type PendingRequest = {
  event(event: AssistantMessageEvent): void;
  options: SimpleStreamOptions;
};

/** A worker's reverse calls reach only requests sent to that worker. */
export class ProviderRequests {
  readonly pending = new Map<number, PendingRequest>();
  #next = 0;

  readonly callbacks: Pick<
    HostFunctions,
    "providerEvent" | "providerPayload" | "providerResponse" | "providerStreamEvent"
  > = {
    providerEvent: (id, event) => this.pending.get(id)?.event(event),
    providerPayload: async (id, payload, model) =>
      this.pending.get(id)?.options.onPayload?.(payload, model),
    providerResponse: async (id, response, model) =>
      this.pending.get(id)?.options.onResponse?.(response, model),
    providerStreamEvent: async (id, data, model) =>
      this.pending.get(id)?.options.onProviderStreamEvent?.(data, model),
  };

  add(request: PendingRequest) {
    const id = ++this.#next;
    this.pending.set(id, request);
    return id;
  }
}

interface Registration {
  settings: ProviderSettings;
  /** A function stays on its worker while any attached session uses it. */
  handler?: number;
}

interface InstalledProvider {
  readonly runtime: Runtime;
  readonly previous: ReturnType<Runtime["getRegisteredProviderConfig"]>;
  readonly native: Provider | undefined;
  current: ReturnType<Runtime["getRegisteredProviderConfig"]>;
  readonly sessions: Map<ProviderSession, Registration>;
}

const catalogs = new WeakMap<Models, Map<string, InstalledProvider>>();

/** Registrations owned by one opening of a conversation on a worker. */
export class ProviderSession {
  readonly #catalog: Map<string, InstalledProvider>;
  readonly #models: Models;
  readonly #sessionId: string;
  readonly #harness: Harness;
  readonly #conversation: ConversationId;
  readonly #rpc: WorkerRpc;
  readonly #requests: ProviderRequests;
  readonly #life = new AbortController();
  readonly #parked = new Map<TaskId, { controllers: Set<AbortController> }>();

  constructor(
    models: Models,
    sessionId: string,
    harness: Harness,
    conversation: ConversationId,
    rpc: WorkerRpc,
    requests: ProviderRequests,
  ) {
    this.#models = models;
    this.#catalog = catalogs.get(models) ?? new Map();
    catalogs.set(models, this.#catalog);
    this.#sessionId = sessionId;
    this.#harness = harness;
    this.#conversation = conversation;
    this.#rpc = rpc;
    this.#requests = requests;
  }

  register(name: string, settings: ProviderSettings, handler?: number) {
    this.#life.signal.throwIfAborted();
    const models = this.#models;
    if (!supportsProviders(models))
      throw new Error(
        "registerProvider is not supported by these Harness models; supply a Pi ModelRuntime",
      );
    const entry = this.#catalog.get(name) ?? {
      runtime: models,
      previous: models.getRegisteredProviderConfig(name),
      native: models.getRegisteredNativeProvider(name),
      current: models.getRegisteredProviderConfig(name),
      sessions: new Map<ProviderSession, Registration>(),
    };
    if (models.getRegisteredProviderConfig(name) !== entry.current) {
      throw new Error(`Provider "${name}" was replaced outside the extension host`);
    }
    const previous = entry.sessions.get(this);
    const effective = {
      ...previous?.settings,
      ...Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)),
    };
    const registration: Registration = {
      settings: effective,
      handler: handler ?? previous?.handler,
    };
    for (const [peer, other] of entry.sessions) {
      if (peer === this) continue;
      if (
        !isDeepStrictEqual(effective, other.settings) ||
        (registration.handler === undefined) !== (other.handler === undefined)
      ) {
        throw new Error(
          `Provider "${name}" has different settings in another conversation using these models`,
        );
      }
    }
    if (
      !entry.sessions.size ||
      (previous && !isDeepStrictEqual(previous.settings, effective)) ||
      (!!previous && (previous.handler === undefined) !== (registration.handler === undefined))
    ) {
      const config: ProviderConfig = { ...settings };
      if (registration.handler !== undefined) {
        config.streamSimple = (model, context, options = {}) =>
          lazyStream(
            model,
            async () => {
              const selected = [...entry.sessions].filter(
                ([session]) =>
                  options.sessionId === undefined || session.#sessionId === options.sessionId,
              );
              const owner = selected.length === 1 ? selected[0] : undefined;
              if (!owner || owner[1].handler === undefined)
                throw new Error(
                  `No unique attached conversation for provider "${name}" and session "${options.sessionId ?? ""}"`,
                );
              return owner[0].#stream(owner[1].handler, model, context, options);
            },
            undefined,
            options.signal,
          );
      }
      models.registerProvider(name, config);
      entry.current = models.getRegisteredProviderConfig(name);
    }
    entry.sessions.set(this, registration);
    this.#catalog.set(name, entry);
    if (previous?.handler !== undefined && previous.handler !== registration.handler)
      this.#release(entry, previous.handler);
  }

  /** A shared registry can reuse a provider's function on this worker. A different worker must register its own. */
  get(name: string) {
    const provider = this.#models.getProvider(name);
    if (!provider) return undefined;
    const entry = this.#catalog.get(name);
    if (
      entry &&
      !entry.sessions.has(this) &&
      entry.runtime.getRegisteredProviderConfig(name) === entry.current
    ) {
      const registration = [...entry.sessions].find(
        ([peer, source]) => source.handler === undefined || peer.#rpc === this.#rpc,
      )?.[1];
      if (!registration) return undefined;
      entry.sessions.set(this, registration);
    }
    return { id: provider.id, name: provider.name, baseUrl: provider.baseUrl };
  }

  unregister(name: string) {
    const entry = this.#catalog.get(name);
    const own = entry?.sessions.get(this);
    if (!entry || !own) return;
    entry.sessions.delete(this);
    if (own.handler !== undefined) this.#release(entry, own.handler);
    if (entry.sessions.size) return;
    this.#catalog.delete(name);
    if (entry.runtime.getRegisteredProviderConfig(name) !== entry.current) return;
    entry.runtime.unregisterProvider(name);
    if (entry.native) entry.runtime.registerNativeProvider(entry.native);
    else if (entry.previous) entry.runtime.registerProvider(name, entry.previous);
  }

  #release(entry: InstalledProvider, id: number) {
    if (
      [...entry.sessions].some(
        ([session, registration]) => session.#rpc === this.#rpc && registration.handler === id,
      )
    )
      return;
    void this.#rpc.releaseProvider.asEvent(id).catch(() => {});
  }

  close() {
    this.#life.abort();
    for (const name of this.#catalog.keys()) this.unregister(name);
  }

  async #stream(
    handler: number,
    model: Model<Api>,
    context: TranscriptContext,
    options: SimpleStreamOptions,
  ) {
    const {
      fetch,
      telemetry: _telemetry,
      onPayload,
      onResponse,
      onProviderStreamEvent,
      signal,
      ...plain
    } = options;
    if (fetch)
      throw new Error("An extension provider running on a worker cannot use a host fetch function");
    const live = this.#life.signal;
    const bound = withAbortSignal(live, BACKGROUND_CONTEXT);
    const run = (await this.#harness.snapshot(LiveDoc, this.#conversation, bound))?.run;
    live.throwIfAborted();
    const controller = transferableAbortController();
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const events = createAssistantMessageEventStream();
    let terminal = false;
    const ended = (message: AssistantMessage) => {
      if (terminal) return;
      terminal = true;
      // A generation invocation retires its signal even on toolUse. Its provider can still be
      // waiting for the tool when the run is aborted between this request and the next one.
      signal?.removeEventListener("abort", cancel);
      if (message.stopReason === "toolUse" && run) this.#park(run.taskId, controller);
    };
    const id = this.#requests.add({
      options,
      event: (event) => {
        if (event.type === "done") ended(event.message);
        if (event.type === "error") ended(event.error);
        events.push(event);
      },
    });
    const stop = () => controller.abort(live.reason);
    live.addEventListener("abort", stop, { once: true });
    const call = this.#rpc.streamProvider(handler, id, model, context, {
      ...plain,
      signal: controller.signal,
      onPayload: !!onPayload,
      onResponse: !!onResponse,
      onProviderStreamEvent: !!onProviderStreamEvent,
    });
    const result = awaitWithContext(call, bound)
      .then((message) => {
        ended(message);
        events.end(message);
        return message;
      })
      .finally(() => {
        live.removeEventListener("abort", stop);
        signal?.removeEventListener("abort", cancel);
        this.#requests.pending.delete(id);
      });
    // An RPC failure must also wake the iterator. lazyStream then reads result() and emits
    // Pi's error message, including when the worker exited before it could send an event.
    void result.catch(() => events.end());
    return { [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](), result: () => result };
  }

  #park(task: TaskId, controller: AbortController) {
    const held = this.#parked.get(task);
    if (held) {
      held.controllers.add(controller);
      return;
    }
    const controllers = new Set([controller]);
    this.#parked.set(task, { controllers });
    const abort = () => {
      for (const signal of controllers) signal.abort();
    };
    const bound = withAbortSignal(this.#life.signal, BACKGROUND_CONTEXT);
    void this.#harness
      .waitForTask(task, bound)
      .then((receipt) => {
        if (receipt.state.outcome.status !== "completed") abort();
      }, abort)
      .finally(() => this.#parked.delete(task));
  }
}
