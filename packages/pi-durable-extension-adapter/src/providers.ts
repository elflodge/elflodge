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
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import { withCauseDetail } from "@earendil-works/pi-ai/utils/error-body";
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

import {
  serializedFailure,
  type HostFunctions,
  type ProviderSettings,
  type WorkerFunctions,
} from "./protocol.ts";

type ProviderRuntime = Pick<
  ModelRuntime,
  | "registerProvider"
  | "unregisterProvider"
  | "getRegisteredProviderConfig"
  | "getRegisteredNativeProvider"
>;

// Duck-typed, not `instanceof ModelRuntime`: the app's ModelRuntime comes from its own copy of the
// coding agent, which can differ from the exact version this package pins.
function supportsProviders(models: Models): models is Models & ProviderRuntime {
  return (
    "registerProvider" in models &&
    typeof models.registerProvider === "function" &&
    "unregisterProvider" in models &&
    typeof models.unregisterProvider === "function" &&
    "getRegisteredProviderConfig" in models &&
    typeof models.getRegisteredProviderConfig === "function" &&
    "getRegisteredNativeProvider" in models &&
    typeof models.getRegisteredNativeProvider === "function"
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
  /** The app's registration, found when an extension first registered the name. */
  readonly previous: ProviderConfig | undefined;
  current: ProviderConfig | undefined;
  /** The conversations that registered the provider, each with whether it registered a stream. */
  readonly sessions: Map<ConversationProviders, boolean>;
  readonly dispatch: NonNullable<ProviderConfig["streamSimple"]>;
}

/** The requests a run's provider queries hold open across its tool rounds, cancelled together. */
interface Parking {
  readonly cancels: Set<(reason?: unknown) => void>;
  /** Cancels them and stops watching the run. */
  cancel(): void;
  /** Stops watching the run without cancelling, once their worker is gone. */
  unwatch(): void;
}

const catalogs = new WeakMap<ProviderRuntime, Map<string, InstalledProvider>>();

/**
 * The providers one attached conversation's extensions registered. A worker's exit withdraws them
 * as a close does, and the reopened extensions register theirs again as at attach.
 */
export class ConversationProviders {
  readonly #catalog: Map<string, InstalledProvider>;
  readonly #models: Models;
  /** The app's model runtime, when its models are one. */
  readonly #runtime: (Models & ProviderRuntime) | undefined;
  readonly #sessionId: string;
  readonly #harness: Harness;
  readonly #conversation: ConversationId;
  readonly #life = new AbortController();
  #worker: ProviderWorker | undefined;
  /** Why the last worker went, for the requests that find none. */
  #gone: Error | undefined;
  readonly #parked = new Map<SubmissionId, Parking>();
  /**
   * Requests of callers other than pi-durable that asked for tools, open until their caller aborts
   * its signal, if it gave one, or the conversation closes; a worker's exit ended them already.
   */
  readonly #held = new Set<{ cancel(reason?: unknown): void; unwatch(): void }>();

  constructor(models: Models, sessionId: string, harness: Harness, conversation: ConversationId) {
    this.#models = models;
    this.#runtime = supportsProviders(models) ? models : undefined;
    // Without a runtime nothing registers, so the catalog stays empty.
    this.#catalog = (this.#runtime && catalogs.get(this.#runtime)) ?? new Map();
    if (this.#runtime) catalogs.set(this.#runtime, this.#catalog);
    this.#sessionId = sessionId;
    this.#harness = harness;
    this.#conversation = conversation;
  }

  /** Model requests go to this instance from now on. */
  bind(worker: ProviderWorker) {
    this.#worker = worker;
  }

  /**
   * The worker exited: the requests on it fail with its error, and the registrations go as at
   * close, since their streams went with the worker. The reopened extensions register again.
   */
  withdraw(error: Error) {
    this.#worker = undefined;
    this.#gone = error;
    for (const parking of this.#parked.values()) parking.unwatch();
    for (const held of this.#held) held.unwatch();
    for (const name of this.#catalog.keys()) this.unregister(name);
  }

  register(name: string, settings: ProviderSettings, customStream: boolean) {
    this.#life.signal.throwIfAborted();
    if (!this.#worker) throw new Error("The conversation's extension worker exited");
    const models = this.#requireRuntime("registerProvider");
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
    // As in Pi, a settings-only update keeps the stream.
    entry.sessions.set(this, customStream || entry.sessions.get(this) === true);
    this.#catalog.set(name, entry);
  }

  #requireRuntime(call: string) {
    if (!this.#runtime)
      throw new Error(`${call} is not supported by these Harness models; supply a Pi ModelRuntime`);
    return this.#runtime;
  }

  #createRegistration(name: string, runtime: ProviderRuntime): InstalledProvider {
    // Pi drops a native provider when the name is registered with settings, and with it the
    // provider's models, until the registration goes.
    if (runtime.getRegisteredNativeProvider(name))
      throw new Error(
        `Provider "${name}" is a native provider of the app; register the extension's under a name of its own`,
      );
    const previous = runtime.getRegisteredProviderConfig(name);
    const catalog = this.#catalog;
    return {
      previous,
      current: previous,
      sessions: new Map(),
      dispatch: (model, context, options = {}) =>
        lazyStream(
          model,
          async () => {
            // A request can hold this function past a worker's exit, as while Pi prepares its
            // headers, so it routes by the registrations of now.
            const matches = [...(catalog.get(name)?.sessions ?? [])].filter(
              ([session, stream]) => stream && session.#sessionId === options.sessionId,
            );
            if (matches.length !== 1) throw unrouted(name, options.sessionId);
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
    // A stream belongs to the extension instance that registered it. Reporting a peer's here
    // would cause extensions that register on first use to skip registering their own.
    if (
      !provider ||
      (entry &&
        this.#runtime?.getRegisteredProviderConfig(name)?.streamSimple === entry.dispatch &&
        entry.sessions.get(this) !== true)
    )
      return undefined;
    return { id: provider.id, name: provider.name, baseUrl: provider.baseUrl };
  }

  unregister(name: string) {
    const runtime = this.#requireRuntime("unregisterProvider");
    const entry = this.#catalog.get(name);
    if (!entry || !entry.sessions.delete(this)) return;
    if (runtime.getRegisteredProviderConfig(name) !== entry.current) {
      if (!entry.sessions.size) this.#catalog.delete(name);
      return;
    }
    if (entry.sessions.size) {
      // The last stream went: the conversations left registered settings alone, which the app's own
      // stream for that API serves, else Pi's built-in one, while the stand-in would find no
      // conversation to route to.
      const streaming = [...entry.sessions.values()].some(Boolean);
      if (streaming || entry.current?.streamSimple !== entry.dispatch) return;
      const { streamSimple: _, ...settings } = entry.current;
      const own = entry.previous?.streamSimple;
      runtime.unregisterProvider(name);
      runtime.registerProvider(
        name,
        own && entry.previous?.api === settings.api ? { ...settings, streamSimple: own } : settings,
      );
      entry.current = runtime.getRegisteredProviderConfig(name);
      return;
    }
    this.#catalog.delete(name);
    runtime.unregisterProvider(name);
    if (entry.previous) runtime.registerProvider(name, entry.previous);
  }

  /**
   * The conversation closed, or its extensions are gone for good: its requests end, with `reason`
   * when given, and its registrations go.
   */
  close(reason?: Error) {
    if (this.#life.signal.aborted) return;
    this.#life.abort(reason);
    for (const parking of this.#parked.values()) parking.cancel();
    for (const held of this.#held) held.cancel();
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
    const run = (await this.#harness.snapshot(LiveDoc, this.#conversation, bound))?.run;
    const submission = run?.inputs[0];
    // Nothing waits between reading the worker and calling it.
    const worker = this.#worker;
    if (!worker) throw this.#gone ?? new Error("The conversation's extension worker exited");
    // The worker may have exited and the reopened extensions registered otherwise meanwhile.
    if (this.#catalog.get(name)?.sessions.get(this) !== true) throw unrouted(name, this.#sessionId);
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
      if (message.stopReason !== "toolUse") return;
      if (submission !== undefined) this.#park(submission, cancel);
      // A caller other than pi-durable runs the tools itself and ends the query by its signal, or
      // by closing the conversation. pi-durable's generation requests always have an input; a run
      // without one has answered and runs only its afterRun tasks, whose direct requests are held
      // the same. pi-durable's other requests, such as a compaction summary, offer no tools.
      else if (!signal?.aborted) this.#hold(signal, cancel);
    };
    // The answer so far, as the worker's last event carried it.
    let latest: AssistantMessage | undefined;
    const id = worker.requests.add({
      options,
      event: (event) => {
        if (!terminal) {
          if (event.type === "done") latest = event.message;
          else if (event.type === "error") latest = event.error;
          else latest = event.partial;
        }
        if (event.type === "done") ended(event.message);
        if (event.type === "error") ended(event.error);
        events.push(event);
      },
    });
    // The worker's IDs are its own, so a cancel goes only to the worker that has the request.
    const cancel = (reason?: unknown) => {
      if (this.#worker !== worker) return;
      // A cancel without a reason, such as a parked query's, aborts as the platform does by default.
      const sent = serializedFailure(reason ?? AbortSignal.abort().reason);
      void worker.rpc.cancelProvider(id, sent).catch(() => {});
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
      .then(undefined, (failure: unknown) => {
        // The worker may have sent the answer's last event before the call failed.
        if (terminal && latest) return latest;
        if (!latest) throw failure;
        // pi-ai's error message carries what streamed so far.
        const reason = signal?.aborted ? "aborted" : "error";
        const message: AssistantMessage = {
          ...latest,
          stopReason: reason,
          errorMessage: withCauseDetail(ensureError(failure)),
        };
        events.push({ type: "error", reason, error: message });
        return message;
      })
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
    // An RPC failure before any event must also wake the iterator. lazyStream then reads result()
    // and emits Pi's error message.
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
      cancel: () => {
        parking.unwatch();
        for (const each of parking.cancels) each();
      },
      unwatch: () => {
        if (this.#parked.get(submission) === parking) this.#parked.delete(submission);
        watching.cancel();
      },
    };
    this.#parked.set(submission, parking);
    const cancelParked = () => {
      if (this.#parked.get(submission) === parking) parking.cancel();
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
      .then(cancelParked, cancelParked);
    void this.#harness
      .watchTaskGraph(watching.context)
      .then((watch) => {
        // Cancelled or withdrawn while the watch was acquired, or aborted already: a stopped watch
        // cannot start.
        if (this.#parked.get(submission) !== parking) return;
        if (abortedRun(watch.value)) return cancelParked();
        watch.start(async (call) => {
          if (call.kind === "value" && abortedRun(call.value)) cancelParked();
        });
      })
      // Without the watch, the input's settling still cancels them.
      .catch(() => {});
  }

  #hold(signal: AbortSignal | undefined, cancel: (reason?: unknown) => void) {
    const aborted = () => held.cancel(signal?.reason);
    const held = {
      cancel: (reason?: unknown) => {
        held.unwatch();
        cancel(reason);
      },
      unwatch: () => {
        this.#held.delete(held);
        signal?.removeEventListener("abort", aborted);
      },
    };
    this.#held.add(held);
    signal?.addEventListener("abort", aborted, { once: true });
  }
}

/** Why a request finds no stream to route to, as while a conversation's extensions open again. */
function unrouted(name: string, sessionId: string | undefined) {
  return new Error(
    `No attached conversation with session "${sessionId ?? ""}" has a stream registered for provider "${name}". Extensions whose worker exited register theirs again once they have opened again.`,
  );
}
