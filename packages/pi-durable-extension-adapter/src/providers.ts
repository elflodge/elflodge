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
  type SubmissionId,
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

export function supportsProviders(models: Models): models is Models & Runtime {
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

interface InstalledProvider {
  readonly runtime: Runtime;
  readonly previous: ProviderConfig | undefined;
  readonly native: Provider | undefined;
  current: ProviderConfig | undefined;
  /** Only instances that registered a stream may receive a model request. */
  readonly sessions: Map<ProviderSession, boolean>;
  readonly dispatch: NonNullable<ProviderConfig["streamSimple"]>;
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
  readonly #route: string;
  readonly #life = new AbortController();
  readonly #parked = new Map<SubmissionId, Set<AbortController>>();

  constructor(
    models: Models,
    sessionId: string,
    harness: Harness,
    conversation: ConversationId,
    rpc: WorkerRpc,
    requests: ProviderRequests,
    route: string,
  ) {
    this.#models = models;
    this.#catalog = catalogs.get(models) ?? new Map();
    catalogs.set(models, this.#catalog);
    this.#sessionId = sessionId;
    this.#harness = harness;
    this.#conversation = conversation;
    this.#rpc = rpc;
    this.#requests = requests;
    this.#route = route;
  }

  register(name: string, settings: ProviderSettings, customStream: boolean) {
    this.#life.signal.throwIfAborted();
    const models = this.#models;
    if (!supportsProviders(models))
      throw new Error(
        "registerProvider is not supported by these Harness models; supply a Pi ModelRuntime",
      );
    const entry = this.#catalog.get(name) ?? this.#createRegistration(name, models);
    if (models.getRegisteredProviderConfig(name) !== entry.current)
      throw new Error(`Provider "${name}" was replaced outside the extension host`);

    if (entry.sessions.size > (entry.sessions.has(this) ? 1 : 0)) {
      // A shared catalog can discover new models. Changing where a peer sends requests or
      // which credentials it uses requires a separate runtime.
      for (const field of ["api", "baseUrl", "apiKey", "authHeader", "headers"] as const) {
        if (
          settings[field] !== undefined &&
          !isDeepStrictEqual(settings[field], entry.current?.[field])
        )
          throw new Error(
            `Provider "${name}" has different ${field} settings in another conversation using these models`,
          );
      }
      if (customStream && entry.current?.streamSimple !== entry.dispatch)
        throw new Error(
          `Provider "${name}" already serves another conversation without this custom stream`,
        );
    }
    // Pi validates each incoming registration and merges it with the previous one. In particular,
    // a headers-only update must reach Pi without streamSimple, even on a streaming provider.
    models.registerProvider(
      name,
      customStream ? { ...settings, streamSimple: entry.dispatch } : settings,
    );
    entry.current = models.getRegisteredProviderConfig(name);
    entry.sessions.set(this, customStream || entry.sessions.get(this) === true);
    this.#catalog.set(name, entry);
  }

  #createRegistration(name: string, runtime: Runtime): InstalledProvider {
    const sessions = new Map<ProviderSession, boolean>();
    const previous = runtime.getRegisteredProviderConfig(name);
    return {
      runtime,
      previous,
      current: previous,
      native: runtime.getRegisteredNativeProvider(name),
      sessions,
      dispatch: (model, context, options = {}) =>
        lazyStream(
          model,
          async () => {
            const matches = [...sessions].filter(
              ([session, custom]) => custom && session.#sessionId === options.sessionId,
            );
            if (matches.length !== 1)
              throw new Error(
                `No unique attached conversation for provider "${name}" and session "${options.sessionId ?? ""}"`,
              );
            return matches[0][0].#stream(name, model, context, options);
          },
          undefined,
          options.signal,
        ),
    };
  }

  get(name: string) {
    const provider = this.#models.getProvider(name);
    const entry = this.#catalog.get(name);
    // A worker closure belongs to its own extension instance. Reporting a peer's closure here
    // would cause extensions that register on first use to skip this conversation.
    if (
      !provider ||
      (entry &&
        entry.runtime.getRegisteredProviderConfig(name)?.streamSimple === entry.dispatch &&
        !entry.sessions.get(this))
    )
      return undefined;
    return { id: provider.id, name: provider.name, baseUrl: provider.baseUrl };
  }

  unregister(name: string) {
    if (!supportsProviders(this.#models))
      throw new Error(
        "unregisterProvider is not supported by these Harness models; supply a Pi ModelRuntime",
      );
    const entry = this.#catalog.get(name);
    if (!entry || !entry.sessions.delete(this) || entry.sessions.size) return;
    this.#catalog.delete(name);
    if (entry.runtime.getRegisteredProviderConfig(name) !== entry.current) return;
    entry.runtime.unregisterProvider(name);
    if (entry.native) entry.runtime.registerNativeProvider(entry.native);
    else if (entry.previous) entry.runtime.registerProvider(name, entry.previous);
  }

  close() {
    this.#life.abort();
    for (const name of this.#catalog.keys()) this.unregister(name);
  }

  async #stream(
    name: string,
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
    const submission = (await this.#harness.snapshot(LiveDoc, this.#conversation, bound))?.run
      ?.inputs[0];
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
      if (message.stopReason === "toolUse" && submission !== undefined)
        this.#park(submission, controller);
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
    const call = this.#rpc.streamProvider(this.#route, name, id, model, context, {
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

  #park(submission: SubmissionId, controller: AbortController) {
    const held = this.#parked.get(submission);
    if (held) {
      held.add(controller);
      return;
    }
    const controllers = new Set([controller]);
    this.#parked.set(submission, controllers);
    // Successive tool rounds hand the run to new generation tasks. Its first input stays
    // placed throughout, including when a tool terminates the run without another request.
    const release = () => {
      this.#parked.delete(submission);
      for (const parked of controllers) parked.abort();
    };
    const bound = withAbortSignal(this.#life.signal, BACKGROUND_CONTEXT);
    void this.#harness
      .submission(submission, bound)
      .then((input) => input?.wait(bound))
      .then(release, release);
  }
}
