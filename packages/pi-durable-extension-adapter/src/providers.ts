import {
  awaitWithContext,
  BACKGROUND_CONTEXT,
  withAbortSignal,
  withCancel,
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
  GenerationTask,
  LiveDoc,
  type ConversationId,
  type Harness,
  type SubmissionId,
  type TaskGraph,
} from "@earendil-works/pi-durable";
import type { BirpcReturn } from "birpc";
import ensureError from "ensure-error";

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

/**
 * One worker's model requests, by an ID unique on that worker, which its reverse calls and the
 * host's cancels name. A worker's reverse calls reach only requests sent to that worker.
 */
export class ProviderRequests {
  readonly #pending = new Map<number, PendingRequest>();
  #next = 0;

  readonly callbacks: Pick<
    HostFunctions,
    "providerEvent" | "providerPayload" | "providerResponse" | "providerStreamEvent"
  > = {
    providerEvent: (id, event) => this.#pending.get(id)?.event(event),
    providerPayload: async (id, payload, model) =>
      this.#pending.get(id)?.options.onPayload?.(payload, model),
    providerResponse: async (id, response, model) =>
      this.#pending.get(id)?.options.onResponse?.(response, model),
    providerStreamEvent: async (id, data, model) =>
      this.#pending.get(id)?.options.onProviderStreamEvent?.(data, model),
  };

  add(request: PendingRequest) {
    const id = ++this.#next;
    this.#pending.set(id, request);
    return id;
  }

  delete(id: number) {
    this.#pending.delete(id);
  }
}

/** The worker a conversation's extensions are open on, and their instance there. */
export interface ProviderWorker {
  readonly rpc: WorkerRpc;
  readonly requests: ProviderRequests;
  readonly route: string;
}

interface InstalledProvider {
  readonly runtime: Runtime;
  readonly previous: ProviderConfig | undefined;
  readonly native: Provider | undefined;
  current: ProviderConfig | undefined;
  /**
   * The conversations that registered the provider, each with the route of the instance whose
   * stream it registered, if any. Only conversations with a stream may receive a model request.
   */
  readonly sessions: Map<ProviderSession, string | undefined>;
  readonly dispatch: NonNullable<ProviderConfig["streamSimple"]>;
}

/** The requests a run's provider queries hold open across its tool rounds, cancelled together. */
interface Parking {
  readonly cancels: Set<(reason?: unknown) => void>;
  /** Cancels them and stops watching the run. */
  release(): void;
  /** Stops watching the run without cancelling, once their worker is gone. */
  drop(): void;
}

const catalogs = new WeakMap<Models, Map<string, InstalledProvider>>();

/**
 * The providers one attached conversation registered, from its attach to its close. They outlive
 * a worker's exit, so the conversation keeps its models while its extensions open again; a stream
 * belongs to the instance that registered it, so the reopened instance registers its own.
 */
export class ProviderSession {
  readonly #catalog: Map<string, InstalledProvider>;
  readonly #models: Models;
  readonly #sessionId: string;
  readonly #harness: Harness;
  readonly #conversation: ConversationId;
  /** The opening of the extensions under way, which a model request waits for. */
  readonly #ready: () => Promise<unknown>;
  readonly #life = new AbortController();
  #worker: ProviderWorker | undefined;
  /** Why the last worker went, for the requests that find none. */
  #gone: Error | undefined;
  readonly #parked = new Map<SubmissionId, Parking>();

  constructor(
    models: Models,
    sessionId: string,
    harness: Harness,
    conversation: ConversationId,
    ready: () => Promise<unknown>,
  ) {
    this.#models = models;
    this.#catalog = catalogs.get(models) ?? new Map();
    catalogs.set(models, this.#catalog);
    this.#sessionId = sessionId;
    this.#harness = harness;
    this.#conversation = conversation;
    this.#ready = ready;
  }

  /** Model requests go to this instance from now on. */
  bind(worker: ProviderWorker) {
    this.#worker = worker;
  }

  /**
   * The worker exited. The registrations stay until the extensions open again or are given up on;
   * the requests on that worker fail with its error, and nothing more goes to it.
   */
  unbind(error: Error) {
    this.#worker = undefined;
    this.#gone = error;
    for (const parking of this.#parked.values()) parking.drop();
  }

  register(name: string, settings: ProviderSettings, customStream: boolean) {
    this.#life.signal.throwIfAborted();
    const route = this.#worker?.route;
    if (route === undefined) throw new Error("The conversation's extension worker exited");
    const models = this.#models;
    if (!supportsProviders(models))
      throw new Error(
        "registerProvider is not supported by these Harness models; supply a Pi ModelRuntime",
      );
    const entry = this.#catalog.get(name) ?? this.#createRegistration(name, models);
    if (models.getRegisteredProviderConfig(name) !== entry.current)
      throw new Error(`Provider "${name}" was replaced outside the extension host`);

    // Installing a custom stream would strand a peer that uses Pi's built-in stream.
    if (
      customStream &&
      entry.current?.streamSimple !== entry.dispatch &&
      entry.sessions.size > (entry.sessions.has(this) ? 1 : 0)
    )
      throw new Error(
        `Provider "${name}" already serves another conversation without this custom stream`,
      );
    // Pi validates each incoming registration and merges it with the previous one. In particular,
    // a headers-only update must reach Pi without streamSimple, even on a streaming provider.
    models.registerProvider(
      name,
      customStream ? { ...settings, streamSimple: entry.dispatch } : settings,
    );
    entry.current = models.getRegisteredProviderConfig(name);
    entry.sessions.set(this, customStream ? route : entry.sessions.get(this));
    this.#catalog.set(name, entry);
  }

  #createRegistration(name: string, runtime: Runtime): InstalledProvider {
    const sessions = new Map<ProviderSession, string | undefined>();
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
              ([session, route]) => route !== undefined && session.#sessionId === options.sessionId,
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
    // A stream belongs to the extension instance that registered it, which may be a peer's, or
    // this conversation's before its worker exited. Reporting it here would cause extensions that
    // register on first use to skip registering their own.
    if (
      !provider ||
      (entry &&
        entry.runtime.getRegisteredProviderConfig(name)?.streamSimple === entry.dispatch &&
        (this.#worker === undefined || entry.sessions.get(this) !== this.#worker.route))
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

  /**
   * The conversation closed, or its extensions are gone for good: its requests end, with `reason`
   * when given, and its registrations go.
   */
  close(reason?: Error) {
    if (this.#life.signal.aborted) return;
    this.#life.abort(reason);
    for (const parking of this.#parked.values()) parking.release();
    for (const name of this.#catalog.keys()) this.unregister(name);
    this.#worker = undefined;
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
    // A request that comes while the extensions open again after their worker exited waits for
    // them, as hooks and tool calls do.
    await awaitWithContext(this.#ready(), signal ? withAbortSignal(signal, bound) : bound);
    const worker = this.#worker;
    if (!worker) throw this.#gone ?? new Error("The conversation's extension worker exited");
    const submission = (await this.#harness.snapshot(LiveDoc, this.#conversation, bound))?.run
      ?.inputs[0];
    live.throwIfAborted();
    signal?.throwIfAborted();
    const events = createAssistantMessageEventStream();
    let terminal = false;
    const ended = (message: AssistantMessage) => {
      if (terminal) return;
      terminal = true;
      // A generation invocation retires its signal even on toolUse. Its provider can still be
      // waiting for the tool when the run is aborted between this request and the next one.
      signal?.removeEventListener("abort", aborted);
      if (message.stopReason === "toolUse" && submission !== undefined)
        this.#park(submission, cancel);
    };
    const id = worker.requests.add({
      options,
      event: (event) => {
        if (event.type === "done") ended(event.message);
        if (event.type === "error") ended(event.error);
        events.push(event);
      },
    });
    // The worker's IDs are its own, so a cancel goes only to the worker that has the request.
    const cancel = (reason?: unknown) => {
      if (this.#worker !== worker) return;
      void worker.rpc.cancelProvider(worker.route, id, cloneable(reason)).catch(() => {});
    };
    const aborted = () => cancel(signal?.reason);
    const closed = () => cancel(live.reason);
    // birpc posts a call as it is made (only a channel's first call waits, and `open` is always
    // first), so a cancel sent after this call follows it on the port, where the worker has
    // registered the request by the time the cancel arrives.
    const call = worker.rpc.streamProvider(worker.route, name, id, model, context, {
      ...plain,
      onPayload: !!onPayload,
      onResponse: !!onResponse,
      onProviderStreamEvent: !!onProviderStreamEvent,
    });
    signal?.addEventListener("abort", aborted, { once: true });
    live.addEventListener("abort", closed, { once: true });
    const result = awaitWithContext(call, bound)
      .then((message) => {
        ended(message);
        events.end(message);
        return message;
      })
      .finally(() => {
        live.removeEventListener("abort", closed);
        signal?.removeEventListener("abort", aborted);
        worker.requests.delete(id);
      });
    // An RPC failure must also wake the iterator. lazyStream then reads result() and emits
    // Pi's error message, including when the worker exited before it could send an event.
    void result.catch(() => events.end());
    return { [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](), result: () => result };
  }

  /**
   * Keeps a request that asked for tools cancellable until its run ends. Successive tool rounds
   * hand the run to new generation tasks, while its first input stays placed throughout, including
   * when a tool terminates the run without another request. An abort reaches the run's generation
   * task at once, while its input settles only once every tool has returned.
   */
  #park(submission: SubmissionId, cancel: (reason?: unknown) => void) {
    const held = this.#parked.get(submission);
    if (held) {
      held.cancels.add(cancel);
      return;
    }
    const watching = withCancel(withAbortSignal(this.#life.signal, BACKGROUND_CONTEXT));
    const parking: Parking = {
      cancels: new Set([cancel]),
      release: () => {
        parking.drop();
        for (const each of parking.cancels) each();
      },
      drop: () => {
        if (this.#parked.get(submission) === parking) this.#parked.delete(submission);
        watching.cancel();
      },
    };
    this.#parked.set(submission, parking);
    const release = () => {
      if (this.#parked.get(submission) === parking) parking.release();
    };
    const abortedRun = (graph: TaskGraph) =>
      Object.values(graph.tasks).some(
        (task) =>
          task.conversationId === this.#conversation &&
          task.kind === GenerationTask.definition.name &&
          task.abortRequested,
      );
    void this.#harness
      .submission(submission, watching.context)
      .then((input) => input?.wait(watching.context))
      .then(release, release);
    void this.#harness.watchTaskGraph(watching.context).then(
      (watch) => {
        if (abortedRun(watch.value)) release();
        watch.start(async (call) => {
          if (call.kind === "value" && abortedRun(call.value)) release();
        });
        // Without the watch, the input's settling still releases them.
      },
      () => {},
    );
  }
}

/** `reason` as it can cross to the worker: a value that cannot be copied goes as its message. */
function cloneable(reason: unknown) {
  try {
    structuredClone(reason);
    return reason;
  } catch {
    return new Error(ensureError(reason).message);
  }
}
