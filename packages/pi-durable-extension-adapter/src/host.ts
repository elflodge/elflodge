import { constants } from "node:buffer";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { MessageChannel, Worker, type WorkerOptions } from "node:worker_threads";

import {
  awaitWithContext,
  BACKGROUND_CONTEXT,
  type Context,
  withAbortSignal,
} from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import {
  type Api,
  type AssistantMessage,
  getCurrentSystemMessage,
  type ImageContent,
  type Message,
  type Model,
  type Models,
  type SystemMessage,
  type Usage,
} from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { isContextOverflow, isRecoverableLength } from "@earendil-works/pi-ai/utils/overflow";
import { contentText } from "@earendil-works/pi-ai/utils/text";
import type {
  CompactionEntry as SessionCompactionEntry,
  ContextUsage,
  ExecResult,
  InputEvent,
  InputEventResult,
  SessionCompactEvent,
  SessionCompactFailedEvent,
  SessionEntry,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  AgentDoc,
  type AgentState,
  type CommitChange,
  type CommitObservation,
  type CommitPublication,
  CompactionEntry,
  type CompactionInput,
  type CompactionResult,
  CompactionTask,
  type CompactionReason,
  defineExtension,
  defineTool,
  type ConversationId,
  type EntryId,
  type EntryQuery,
  type EntryRecord,
  type Cursor,
  defineDoc,
  type GenerationCheckpoint,
  type SubmissionId,
  type Page,
  type PromptInput,
  type PromptSection,
  type GenerationHooks,
  GenerationTask,
  type Harness,
  hook,
  type HookApi,
  type HookRegistration,
  LiveDoc,
  type LiveRun,
  type LiveState,
  ProviderDoc,
  type Registry,
  section,
  SystemEntry,
  type RunSummary,
  ToolTask,
  UserEntry,
  type Conversation,
  type ToolExecutionResult,
  type ToolHookCall,
  type TaskId,
  type ToolRegistration,
  type TypedEntry,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createBirpc, type BirpcReturn } from "birpc";
import ensureError from "ensure-error";
import { SyncMessagePort } from "sync-message-port";
import Type, { type Static } from "typebox";
import { Guard } from "typebox/guard";
import { Value } from "typebox/value";

import type { PreparedExtensions } from "./prepare.ts";
import { serializedFailure, toJson } from "./protocol.ts";
import type {
  Action,
  AgentStartTrigger,
  ExtensionError,
  Flags,
  HandlerError,
  HostFunctions,
  JournalMessage,
  Opened,
  ReadReply,
  ReadRequest,
  Reads,
  Registrations,
  ToolDescriptor,
  ToolResult,
  WorkerData,
  WorkerFunctions,
} from "./protocol.ts";
import { ConversationProviders, ProviderRequests } from "./providers.ts";

/** How `startExtensionHost` runs extensions. */
export interface ExtensionHostOptions {
  /** What `prepareExtensions` gave. */
  readonly prepared: PreparedExtensions;
  /**
   * The most worker threads extensions run in; each holds the extensions' modules once. Default 2,
   * so a worker busy with one conversation's handler does not hold up every other.
   */
  readonly maxWorkers?: number;
  /**
   * How long a worker with no conversation stays before it exits, in milliseconds. Default 30 s, so
   * conversations that follow each other reuse a worker rather than load the extensions again, as
   * long as pi-durable's own image worker stays idle (`images/node.js`).
   */
  readonly idleTimeout?: number;
  /**
   * Called when an extension's handler fails after it loaded, which Pi catches so the conversation
   * goes on, and when a registration fails as its extensions open again after a worker exit, when
   * nobody reads the attachment's errors. Default: written to standard error, as Pi's print mode
   * writes it.
   */
  readonly onError?: (error: HandlerError, conversation: ConversationId) => void;
  /**
   * Node's options for the worker threads: `resourceLimits` caps their JavaScript heap, so a worker
   * that fills it exits alone and the process goes on (memory outside the heap, such as buffers,
   * is not capped); `env` is their `process.env`, by default the process's.
   */
  readonly workerOptions?: Pick<WorkerOptions, "env" | "resourceLimits">;
  /**
   * Whether the extensions of a worker's conversations are opened again on another worker when it
   * exits, as after a restart. Default true.
   */
  readonly restart?: boolean;
  /**
   * Called when a worker exits with conversations attached, once each was opened again or lost.
   * Default: written to standard error.
   */
  readonly onWorkerExit?: (error: Error, conversations: WorkerExit) => void;
}

/** What became of a worker's conversations when it exited. */
export interface WorkerExit {
  /** Their extensions run on another worker, started again with `session_start` reason `resume`. */
  readonly reopened: readonly ConversationId[];
  /**
   * Their extensions are gone: opening them again failed, as when the new worker also exits while
   * loading them, an extension that loaded before fails to load, or loading takes longer than 10 s;
   * or `restart` is false. Their tools fail, their hooks do nothing, and a `tool_call` gate blocks.
   */
  readonly lost: readonly ConversationId[];
}

/** What `attach` binds a conversation's extensions to. */
export interface AttachOptions {
  readonly harness: Harness;
  readonly conversation: Conversation;
  /** The registry the conversation's agent takes its extensions from; attaching installs one in it. */
  readonly registry: Registry;
  /**
   * The models the Harness was opened with, which extensions read and switch between and get
   * credentials from. `Harness` does not expose its own.
   */
  readonly models: Models;
  /** The environment `pi.exec` runs commands in; without one, `pi.exec` throws. */
  readonly env?: ExecutionEnv;
  /** The directory extensions see as `ctx.cwd`. */
  readonly cwd: string;
  /**
   * Values for the flags extensions register (`pi.registerFlag`), by name, as Pi's command line
   * gives them: set once the extensions have loaded, so `getFlag` returns them from `session_start`.
   */
  readonly flags?: Flags;
  /**
   * Called once if the conversation's extensions are lost, as `WorkerExit` describes, with why
   * their worker exited. Unlike `onWorkerExit`, it tells apart conversations of different Harnesses,
   * whose IDs can be the same.
   */
  readonly onLost?: (error: Error) => void;
}

/** What `input` handlers are told of the input besides its text, as Pi's `prompt` options say. */
export interface InputOptions {
  readonly images?: readonly ImageContent[];
  /** Where the input came from. Default `"rpc"`, as Pi's RPC mode says of a client's prompt. */
  readonly source?: InputEvent["source"];
  /**
   * How it is to be submitted if the conversation is busy, which handlers are told only while a
   * run is under way, as Pi tells them only while its agent runs.
   */
  readonly streamingBehavior?: InputEvent["streamingBehavior"];
}

/** One conversation's extensions. */
export interface AttachedExtensions {
  /**
   * Extensions that failed to load for this conversation, with the reason; the rest run. A flag
   * value that no extension registered, source `flags`, or of the wrong type is reported here too,
   * as is a provider registration the adapter refused, whose extension otherwise runs.
   */
  readonly errors: readonly ExtensionError[];
  /**
   * Runs the extensions' `input` handlers on input before it is submitted, as Pi does for a
   * prompt: the result says to submit it as it is, transformed, or not at all. It throws after
   * `close`.
   */
  input(text: string, options?: InputOptions): Promise<InputEventResult>;
  /**
   * Ends the extensions' session: `session_shutdown` runs, and what they do later, such as a
   * background message, is dropped. Call it when the conversation's work is decided.
   */
  close(): Promise<void>;
}

export interface ExtensionHost {
  /**
   * Starts the extensions for `conversation` on a worker, and installs a pi-durable extension for
   * it in `registry`, `pi-durable-extension-adapter:<conversation ID>`, with their tools and only the
   * hooks they listen to, which the conversation's stored selection gets. Fails when it finds the
   * default selection selecting such extensions, as without the Harness's `settings.extensions`.
   */
  attach(options: AttachOptions, context: Context): Promise<AttachedExtensions>;
  /** Closes every attached conversation's extensions and stops the workers. */
  close(): Promise<void>;
}

/**
 * Runs Pi coding-agent extensions for pi-durable conversations, in a pool of worker threads: none
 * while no conversation is attached, at most `maxWorkers`, each hosting many conversations, one
 * instance of every extension per conversation.
 */
export function startExtensionHost(options: ExtensionHostOptions): ExtensionHost {
  loadAddons(options.prepared.addons);
  const workers = new Workers(options);
  const installationFor = ({ harness, registry }: AttachOptions) => {
    let found = installations.get(registry);
    if (!found) {
      found = new Installation(workers, harness, registry, () => installations.delete(registry));
      installations.set(registry, found);
    }
    // Two hosts would each attach a conversation under the same extension name, which the
    // registry replaces.
    if (found.workers !== workers) throw new Error("A registry can serve one extension host only");
    // Hooks and tools know their conversation's ID only, which is unique within one Harness.
    if (found.harness !== harness) throw new Error("A registry can serve one Harness only");
    return found;
  };
  return {
    attach: (attach, context) =>
      attachConversation(workers, installationFor(attach), attach, context),
    close: () => workers.close(),
  };
}

/**
 * What `session_compact_failed` follows across commits, by Harness rather than by attachment, so a
 * conversation whose extensions close and attach again, the last of the Harness's too, neither
 * tells a compaction twice nor misses its summary going stale. An ID whose end no observer saw,
 * as when no attached conversation listened then, stays until the Harness goes. A restart forgets
 * them: a compaction that was ending then may be told again, and a summary dropped after it is not.
 */
type CompactionTracking = {
  /**
   * The compactions told, or whose summary's write is followed, when they were seen `completing`,
   * until they are `terminal`.
   */
  readonly told: Set<TaskId>;
  /** The summaries waiting in write submissions to be placed, until they settle. */
  readonly placing: Map<
    SubmissionId,
    { readonly reason: CompactionReason; readonly fromExtension: boolean }
  >;
};

const compactionTracking = new WeakMap<Harness, CompactionTracking>();

/** Every host's installations, by registry, so a second host on one registry is refused. */
const installations = new WeakMap<Registry, Installation>();

/**
 * Loads each native add-on the extensions use once in this thread, where it stays loaded. Node
 * unloads a worker's add-ons when the worker exits, and an add-on that left a thread-local
 * destructor behind (napi-rs before 3.12.1, as in `ffi-rs`) then crashes the process; one the
 * process already holds is never unloaded (zhangyuang/node-ffi-rs#145). An add-on that fails here
 * is left to fail in the worker, where its extension reports it.
 */
function loadAddons(addons: readonly string[]) {
  const require = createRequire(import.meta.url);
  for (const addon of addons) {
    try {
      require(addon);
    } catch {
      // Reported by the extension that loads it.
    }
  }
}

const workerModule = fileURLToPath(
  new URL(`./host-worker${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);

interface HostedWorker {
  readonly requests: ProviderRequests;
  readonly worker: Worker;
  readonly rpc: BirpcReturn<WorkerFunctions, HostFunctions>;
  readonly conversations: Map<string, AttachedConversation>;
  idle: ReturnType<typeof setTimeout> | undefined;
  /** Keeps the process alive, or lets it exit, for the worker and its channels. */
  hold(held: boolean): void;
}

/**
 * Calls one of the app's callbacks. What it throws or rejects with is logged, after `context`, and
 * fails nothing else: the host runs every other conversation. It is logged as thrown, since
 * ensure-error assigns to an error's cause, which throws on a frozen one.
 */
function callApp(callback: () => unknown, context?: string) {
  const failed = (failure: unknown) => {
    if (context !== undefined) console.error(context);
    console.error(failure);
  };
  try {
    void Promise.resolve(callback()).catch(failed);
  } catch (failure) {
    failed(failure);
  }
}

/**
 * The workers, each with its conversations. A conversation goes to an idle worker, else to a new
 * one while fewer than `maxWorkers` run, else to the least busy, and stays there; a worker exits
 * once it has had no conversation for `idleTimeout`. Effect's `Pool` caps the borrowers of an item
 * and makes the rest wait, while a conversation holds its worker for as long as it is attached.
 */
class Workers {
  readonly #options: ExtensionHostOptions;
  readonly #workers = new Set<HostedWorker>();
  /**
   * Conversations whose worker exited and that are still attached, which `close` still closes:
   * their tools stay installed.
   */
  readonly #orphans = new Set<AttachedConversation>();
  #closed = false;

  constructor(options: ExtensionHostOptions) {
    this.#options = options;
  }

  /**
   * Reports a failure Pi caught so the conversation goes on: a handler's, or a registration's as
   * extensions open again. An `onError` that throws or rejects fails neither.
   */
  report(error: HandlerError, conversation: ConversationId) {
    const { onError } = this.#options;
    const message = `Extension error (${error.source}): ${error.message}`;
    if (onError) callApp(() => onError(error, conversation), message);
    else console.error(message);
  }

  acquire(key: string, conversation: AttachedConversation): HostedWorker {
    if (this.#closed) throw new Error("The extension host is closed");
    const max = this.#options.maxWorkers ?? 2;
    let chosen: HostedWorker | undefined;
    for (const each of this.#workers) {
      if (!chosen || each.conversations.size < chosen.conversations.size) chosen = each;
    }
    if (!chosen || (chosen.conversations.size > 0 && this.#workers.size < max)) {
      chosen = this.#start();
    }
    clearTimeout(chosen.idle);
    chosen.idle = undefined;
    chosen.hold(true);
    chosen.conversations.set(key, conversation);
    return chosen;
  }

  release(hosted: HostedWorker, key: string, conversation: AttachedConversation) {
    this.#orphans.delete(conversation);
    // Once per opening, as its key is its own.
    if (!hosted.conversations.delete(key)) return;
    if (hosted.conversations.size > 0 || this.#closed) return;
    // An idle worker is no reason for the process to stay.
    hosted.hold(false);
    hosted.idle = setTimeout(() => {
      this.#workers.delete(hosted);
      void hosted.worker.terminate();
    }, this.#options.idleTimeout ?? 30_000);
    hosted.idle.unref();
  }

  async close() {
    this.#closed = true;
    const all = [...this.#workers];
    this.#workers.clear();
    await Promise.allSettled([...this.#orphans].map((each) => each.close()));
    this.#orphans.clear();
    for (const hosted of all) {
      clearTimeout(hosted.idle);
      await Promise.allSettled([...hosted.conversations.values()].map((each) => each.close()));
      await hosted.worker.terminate();
    }
  }

  /**
   * Opens the extensions of an exited worker's conversations again on another, as after a restart,
   * once: a reopen that fails, as when the new worker also exits while loading them, leaves them
   * lost rather than try again. Those the worker was loading are left to what was opening them,
   * `attach`, which fails, or a reopen, which reports them; those being closed are left to `close`.
   */
  async #recover(
    error: Error,
    hosting: readonly AttachedConversation[],
    loading: ReadonlySet<AttachedConversation>,
  ) {
    const affected = hosting.filter((each) => !loading.has(each) && !each.closing);
    if (affected.length === 0) return;
    const restart = this.#options.restart ?? true;
    const results = await Promise.all(
      affected.map(async (each) => {
        const reopened =
          restart &&
          (await each.reopen().then(
            () => true,
            () => false,
          ));
        if (!reopened && !each.closing) {
          each.providers.close(error);
          if (this.#closed) void each.close();
          else this.#orphans.add(each);
        }
        return { conversation: each, reopened };
      }),
    );
    for (const { conversation, reopened } of results) {
      if (reopened) continue;
      // One attacher's failing report must not keep the others from theirs.
      callApp(() => conversation.reportLost(error));
    }
    const exit: WorkerExit = {
      reopened: results
        .filter((each) => each.reopened)
        .map((each) => each.conversation.conversationId),
      lost: results
        .filter((each) => !each.reopened)
        .map((each) => each.conversation.conversationId),
    };
    const { onWorkerExit } = this.#options;
    if (onWorkerExit) callApp(() => onWorkerExit(error, exit));
    else {
      console.error(
        `${error.message}; extensions opened again for ${exit.reopened.length} conversations, lost for ${exit.lost.length}`,
      );
    }
  }

  #start(): HostedWorker {
    const journal = SyncMessagePort.createChannel();
    const rpc = new MessageChannel();
    const workerData: WorkerData = {
      runtime: this.#options.prepared.runtime,
      extensions: this.#options.prepared.extensions,
      journal: journal.port2,
      rpc: rpc.port2,
    };
    const worker = new Worker(workerModule, {
      ...this.#options.workerOptions,
      workerData,
      transferList: [journal.port2, rpc.port2],
    });
    const conversations = new Map<string, AttachedConversation>();
    const attached = (key: string) => {
      const found = conversations.get(key);
      if (!found) throw new Error(`No conversation ${key} on this worker`);
      return found;
    };
    const requests = new ProviderRequests();
    const functions: HostFunctions = {
      ...requests.callbacks,
      setModel: (key, model) => attached(key).setModel(model),
      exec: (key, id, command, args, options) => attached(key).exec(id, command, args, options),
      cancelExec: (key, id) => conversations.get(key)?.cancelExec(id),
      getApiKeyAndHeaders: (key, model) => attached(key).getApiKeyAndHeaders(model),
      getProviderAuth: (key, provider) => attached(key).models.getAuth(provider),
      getApiKeyForProvider: async (key, provider) =>
        (await attached(key).models.getAuth(provider))?.auth.apiKey,
      changed: (key) => conversations.get(key)?.reloadRegistrations(),
      error: (key, error) => {
        const found = conversations.get(key);
        if (found) this.report(error, found.conversationId);
      },
    };
    const port = rpc.port1;
    const client = createBirpc<WorkerFunctions, HostFunctions>(functions, {
      post: (message) => port.postMessage(message),
      on: (handler) => port.on("message", handler),
      // No time limit: tools and hooks run as long as they need; the worker's exit rejects what is
      // pending.
      timeout: -1,
      // A notice that needs no answer, so none is left waiting when the worker exits.
      eventNames: ["cancelTool", "cancelProvider"],
      // A reply that cannot be posted, such as an app hook's result that cannot be copied, goes to
      // the worker's call as the error instead of ending the process. Other failures, which name
      // no function, still reach this side's caller.
      onGeneralError: (_error, functionName) => functionName !== undefined,
      // A failure goes to the worker as it can be sent.
      resolver: (_name, fn: ((...args: unknown[]) => unknown) | undefined) =>
        fn &&
        async function (this: unknown, ...args: unknown[]) {
          try {
            return await fn.apply(this, args);
          } catch (error) {
            throw serializedFailure(error);
          }
        },
    });
    const reads = new SyncMessagePort(journal.port1);
    const reply = (value: ReadReply) => {
      const sent: ReadReply =
        value.type === "error" ? { type: "error", error: serializedFailure(value.error) } : value;
      try {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker port, not a window
        reads.postMessage(sent);
      } catch (error) {
        // A value that cannot be cloned: the worker waits for an answer all the same, so it gets
        // why the value could not be sent.
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker port, not a window
        reads.postMessage({ type: "error", error: serializedFailure(error) } satisfies ReadReply);
      }
    };
    reads.on("message", (message: JournalMessage) => {
      const found = conversations.get(message.key);
      if (message.type === "act") {
        try {
          found?.act(message.action);
        } catch {
          // An action the host cannot carry out has no one to report to, as with Pi's actions;
          // it must not end the host's process, which runs every other conversation.
        }
        return;
      }
      if (!found) {
        reply({ type: "error", error: new Error(`No conversation ${message.key} on this worker`) });
        return;
      }
      if (message.type !== "read") {
        try {
          if (message.type === "registerProvider")
            found.providers.register(message.name, message.config, message.customStream);
          else found.providers.unregister(message.name);
          reply({ type: "value", value: undefined });
        } catch (error) {
          reply({ type: "error", error });
        }
        return;
      }
      found.read(message).then(
        (value) => reply({ type: "value", value }),
        (error: unknown) => reply({ type: "error", error }),
      );
    });
    const hosted: HostedWorker = {
      requests,
      worker,
      rpc: client,
      conversations,
      idle: undefined,
      // While a conversation is attached, its calls to the worker keep the process alive, as an open
      // socket does, until the host closes it.
      hold(held) {
        for (const each of [worker, port, journal.port1]) {
          if (held) each.ref();
          else each.unref();
        }
      },
    };
    // An extension's uncaught error ends its worker, which then exits; without a listener it would
    // end the host's process instead.
    let failure: Error | undefined;
    worker.on("error", (error) => {
      failure = ensureError(error);
    });
    // A worker that exits while loading, by `process.exit()` or running out of memory, fails the
    // `attach` without naming the extension: that would need the worker to report each load, for a
    // rare case once add-ons are loaded in the host.
    worker.on("exit", (code) => {
      this.#workers.delete(hosted);
      const hosting = [...conversations.values()];
      // Read before the calls in flight fail, which ends their loading.
      const loading = new Set(hosting.filter((each) => each.opening));
      const error = new Error(
        `The extension worker exited${failure ? `: ${failure.message}` : ` with code ${code}`}`,
        { cause: failure },
      );
      client.$close(error);
      for (const each of hosting) each.lost(error);
      if (this.#closed) return;
      // A report the host cannot deliver, such as an `onWorkerExit` that throws, must not end the
      // process, which runs every other conversation.
      this.#recover(error, hosting, loading).catch((failed: unknown) =>
        console.error(ensureError(failed)),
      );
    });
    this.#workers.add(hosted);
    return hosted;
  }
}

async function attachConversation(
  workers: Workers,
  installation: Installation,
  options: AttachOptions,
  context: Context,
): Promise<AttachedExtensions> {
  const { harness, conversation } = options;
  const provider = await harness.snapshot(ProviderDoc, conversation.id, context);
  // A conversation from before pi-durable gave each one a provider session ID gets its ID at its
  // first request (`ensureProviderSessionId`, which pi-durable does not export). The same commit
  // here gives its extensions that ID from the start, whichever models the app passes, so it stays
  // the same after a restart, and their providers' requests, which carry it, reach them.
  const sessionId =
    provider?.sessionId ??
    (await conversation.commit(
      async (tx) => (await tx.doc(ProviderDoc, conversation.id)).sessionId,
      context,
    ));
  const attached = new AttachedConversation(sessionId, options, installation, workers);
  installation.add(attached);
  try {
    await selectExtension(options, installation.conversations(), context);
    const opened = await attached.open(context);
    return {
      // As `ExtensionError`s, the attachment's type: a binding failure's event and stack serve
      // only its report at a reopening.
      errors: opened.errors.map(({ source, message }) => ({ source, message })),
      input: (text, given) => attached.input(text, given),
      close: () => attached.close(),
    };
  } catch (error) {
    // The caller hears at once, at the time limit or when its context is cancelled; closing goes
    // on behind it and frees the worker's place when it ends.
    installation.remove(attached);
    void attached.close();
    throw error;
  }
}

/**
 * Adds the conversation's extension to its stored selection, keeping the rest of it, its order
 * included. Names of others' extensions it inherited, as a subagent or a fork does, go: it has its
 * own now. Fails when the default selection selects the conversations' extensions.
 */
async function selectExtension(
  { harness, conversation }: AttachOptions,
  attached: Iterable<Conversation>,
  context: Context,
) {
  const own = extensionName(conversation.id);
  // A conversation's extension one selects without naming it comes from the default selection: the
  // conversation's own, which `Installation.add` installed for this, or another attached
  // conversation's, as when an app reopens its Harness without the setting. A conversation that
  // selects exactly the names it stores shows nothing of the default, so the first attached one
  // that edits it shows it for all, as they share it.
  for (const each of [conversation, ...attached]) {
    const stored = (await harness.snapshot(AgentDoc, each.id, context))?.extensions;
    if (Array.isArray(stored)) continue;
    const named = new Set(stored?.add);
    const { extensions } = await each.agent(context);
    if (extensions.some(({ name }) => name.startsWith(EXTENSION_PREFIX) && !named.has(name))) {
      throw new Error(
        "Set the Harness's settings.extensions to the extensions conversations select by default: " +
          "without it, every conversation selects every attached conversation's extensions",
      );
    }
    break;
  }
  // The stored document, rather than `configure`, which replaces the selection as a whole. An equal
  // value writes nothing.
  await conversation.commit(async (tx) => {
    const agent = await tx.doc(AgentDoc, conversation.id);
    agent.extensions = replacingAdapterExtensions(agent.extensions, own);
  }, context);
}

/** `selection` with `own` in place of the adapter's other extensions, where it already is if so. */
function replacingAdapterExtensions(
  selection: AgentState["extensions"],
  own: string,
): AgentState["extensions"] {
  const replaced = (names: readonly string[]) => {
    const kept = names.filter((name) => !name.startsWith(EXTENSION_PREFIX) || name === own);
    return kept.includes(own) ? kept : [...kept, own];
  };
  if (Array.isArray(selection)) return replaced(selection);
  return {
    ...(selection?.remove && { remove: selection.remove.filter((name) => name !== own) }),
    add: replaced(selection?.add ?? []),
  };
}

/**
 * The conversations attached through one registry, each with a pi-durable extension of its own,
 * `pi-durable-extension-adapter:<conversation ID>`, holding its extensions' tools and only the hooks
 * they listen to. Its own, rather than one the conversations share, so each is offered only its own
 * extensions' tools, as described by them, as a Pi session is. The conversation's stored agent
 * selects it (`attach`), so the app's default selection must leave it out.
 */
class Installation {
  /** The host that installed it. */
  readonly workers: Workers;
  readonly harness: Harness;
  readonly #registry: Registry;
  readonly #emptied: () => void;
  readonly #conversations = new Map<ConversationId, AttachedConversation>();
  /** What each conversation's extension was installed from, to skip installing the same again. */
  readonly #installedFor = new Map<ConversationId, unknown>();
  /**
   * The Harness's commits, observed while some conversation's extensions listen to `session_compact`
   * or `session_compact_failed`.
   */
  #commits: CommitObservation | undefined;
  /** What `session_compact_failed` follows across commits, for the Harness. */
  readonly compactions: CompactionTracking;

  constructor(workers: Workers, harness: Harness, registry: Registry, emptied: () => void) {
    this.workers = workers;
    this.harness = harness;
    this.#registry = registry;
    this.#emptied = emptied;
    this.compactions = compactionTracking.get(harness) ?? {
      told: new Set(),
      placing: new Map(),
    };
    compactionTracking.set(harness, this.compactions);
  }

  add(conversation: AttachedConversation) {
    if (this.#conversations.has(conversation.id)) {
      throw new Error(`Conversation ${conversation.id} has extensions attached already`);
    }
    this.#conversations.set(conversation.id, conversation);
    this.refresh(conversation);
  }

  /** The attached conversations. */
  *conversations() {
    for (const each of this.#conversations.values()) yield each.conversation;
  }

  remove(conversation: AttachedConversation) {
    if (this.#conversations.get(conversation.id) !== conversation) return;
    this.#conversations.delete(conversation.id);
    this.#installedFor.delete(conversation.id);
    this.#registry.uninstall({ name: extensionName(conversation.id) });
    this.#observeCompactions();
    if (this.#conversations.size === 0) this.#emptied();
  }

  /** Installs the conversation's extension again when its extensions' tools or events changed. */
  refresh(conversation: AttachedConversation) {
    const { id } = conversation;
    if (this.#conversations.get(id) !== conversation) return;
    const { tools, events } = conversation.registrations;
    const wanted = [tools, [...events].toSorted()];
    if (isDeepStrictEqual(wanted, this.#installedFor.get(id))) return;
    this.#installedFor.set(id, wanted);
    this.#registry.install(
      defineExtension({
        name: extensionName(id),
        tools: tools.flatMap((tool) => this.#tool(id, tool)),
        sections: this.#sections(id),
        hooks: this.#hooks(id, new Set(events)),
      }),
    );
    this.#observeCompactions();
  }

  /**
   * Observes the Harness's commits while some conversation's extensions listen to `session_compact`
   * or `session_compact_failed`, for the compaction summaries pi-durable places and the compactions
   * that end without one, as it has no hook after a compaction. Each is seen as its commit is
   * published, before its committer and the waits it resolves go on, so before a generation that
   * placed it, or waits for the compaction, makes its next request.
   */
  #observeCompactions() {
    const listening = [...this.#conversations.values()].some((each) =>
      each.registrations.events.some(
        (event) => event === "session_compact" || event === "session_compact_failed",
      ),
    );
    if (!listening) {
      this.#commits?.detach();
      this.#commits = undefined;
      return;
    }
    if (this.#commits) return;
    let observation: CommitObservation | undefined;
    try {
      observation = this.harness.observeCommits({
        advance: (publication) => this.#handOut(publication),
        // At the Harness's close, or after a failure of `advance`, which detaches it; the next
        // change of the conversations or their extensions' registrations attaches it again while
        // the Harness is open.
        end: () => {
          if (this.#commits === observation) this.#commits = undefined;
        },
      });
      this.#commits = observation;
    } catch {
      // The Harness is closed, and places nothing more.
    }
  }

  /**
   * Hands each attached conversation the changes a commit stored for it, together, as a commit's
   * changes come in no order: a compaction's summary entry, or its task's end and the failure
   * `pi.live` records for it.
   */
  #handOut(publication: CommitPublication) {
    const byConversation = new Map<AttachedConversation, StoredChange[]>();
    for (const change of publication.changes) {
      if (!isStored(change)) continue;
      const conversation = this.#conversations.get(
        change.type === "document" ? change.conversationId : change.value.conversationId,
      );
      if (!conversation) continue;
      const changes = byConversation.get(conversation) ?? [];
      changes.push(change);
      byConversation.set(conversation, changes);
    }
    for (const [conversation, changes] of byConversation) conversation.followCompactions(changes);
  }

  /**
   * The conversation `owner`, when it is the one `api` runs in. A conversation created from it, such
   * as a subagent or a fork, inherits its selection and so its extension, and is not attached: its
   * calls to the tools fail and the hooks do nothing for it.
   */
  #for(owner: ConversationId, api: { conversationId: ConversationId }) {
    return api.conversationId === owner ? this.#conversations.get(owner) : undefined;
  }

  /**
   * Hooks for the Pi events the conversation's extensions listen to, and only those, besides the
   * compaction hook, which notes what the session shows of each compaction.
   */
  #hooks(owner: ConversationId, events: Set<string>): HookRegistration[] {
    const has = (...names: string[]) => names.some((name) => events.has(name));
    const hooks: HookRegistration[] = [];
    if (has("tool_call", "tool_result", "tool_execution_start", "tool_execution_end")) {
      hooks.push(
        hook(ToolTask, {
          ...(has("tool_call", "tool_execution_start") && {
            beforeTool: async (call, api, context) =>
              this.#for(owner, api)?.beforeTool(call, context),
          }),
          // Whenever `beforeTool` is installed too, as the worker ends there the calls it started,
          // and starts the calls pi-durable rejected before its hooks.
          afterTool: async (call, result, api, context) =>
            this.#for(owner, api)?.afterTool(call, result, context),
        }),
      );
    }
    const generation: Partial<GenerationHooks> = {
      // A request also waits for the handlers of a compaction placed, or failed, before it.
      ...(has(...REQUEST_EVENTS, "session_compact", "session_compact_failed") && {
        beforeRequest: async (request, api, context) =>
          this.#for(owner, api)?.beforeRequest(request, api, context),
      }),
      ...(has("before_provider_request") && {
        beforeProviderRequest: async (request, api, context) =>
          this.#for(owner, api)?.beforeProviderRequest(request, context),
      }),
      ...(has("message_end", "turn_end", "session_compact_failed") && {
        afterResponse: async (message, api, context) =>
          this.#for(owner, api)?.afterResponse(message, api, context),
      }),
      ...(has("turn_end") && {
        afterTools: async (assistant, _results, api, context) => {
          await this.#for(owner, api)?.turnEnd(assistant, api, context);
          return undefined;
        },
      }),
      ...(has(...RUN_END_EVENTS, "session_compact_failed") && {
        afterRun: async (run, api, context) => {
          await this.#for(owner, api)?.agentEnd(run, api, context);
          return undefined;
        },
      }),
    };
    if (Object.keys(generation).length > 0) hooks.push(hook(GenerationTask, generation));
    // Whatever the extensions listen to, as it notes what the session shows of each compaction.
    hooks.push(
      hook(CompactionTask, {
        beforeCompact: async (compaction, api, context) =>
          this.#for(owner, api)?.beforeCompact(compaction, api, context),
      }),
    );
    return hooks;
  }

  /**
   * The offered tools' snippets and guidelines, as Pi puts its active tools' in the tools and rules
   * sections of its prompt (`core/system-prompt.js`). The guidelines get rules of their own, apart
   * from those a run's `before_agent_start` adds, which come after the sections render.
   */
  #sections(owner: ConversationId): PromptSection[] {
    const offered = (input: PromptInput) => {
      const own = new Map(
        this.#for(owner, input)?.registrations.tools.map((tool) => [tool.name, tool]),
      );
      return input.agent.tools.flatMap((tool) => own.get(tool.name) ?? []);
    };
    return [
      section(
        "pi-extensions-tools",
        (input) =>
          listSection(
            "tools",
            offered(input).flatMap((tool) =>
              tool.promptSnippet ? [`${tool.name}: ${tool.promptSnippet}`] : [],
            ),
          ),
        { tag: false },
      ),
      section(
        "pi-extensions-tool-rules",
        (input) =>
          listSection("rules", [
            ...new Set(offered(input).flatMap((tool) => tool.promptGuidelines)),
          ]),
        { tag: false },
      ),
    ];
  }

  #tool(owner: ConversationId, descriptor: ToolDescriptor): ToolRegistration[] {
    if (descriptor.exposure === "hidden") return [];
    return [
      defineTool({
        name: descriptor.name,
        description: descriptor.description,
        parameters: descriptor.parameters,
        // A Pi tool may have run part of its work when a crash stops it.
        replay: "unsafe",
        ...(descriptor.executionMode && { executionMode: descriptor.executionMode }),
        ...(descriptor.exposure === "model-only" && { callers: ["model"] as const }),
        // Not offered to the model until something loads it, as Pi activates these tools only when
        // asked; other tools can call them meanwhile.
        ...(inactive(descriptor) && { deferred: true as const }),
        ...(descriptor.prepareArguments && {
          prepareArguments: (args: unknown) => repairArguments(args, descriptor.parameters),
        }),
        execute: async (args, api, context) => {
          const conversation = this.#for(owner, api);
          if (!conversation) throw new Error("No Pi extensions are attached to this conversation");
          return conversation.executeTool(descriptor.name, args, api.callId, context);
        },
      }),
    ];
  }
}

/** How many times extensions have been opened, which numbers each instance. */
let openings = 0;

/** One attached conversation: its extensions' instance on a worker, and the actions it carries out. */
class AttachedConversation {
  /** Pi's session ID for the extensions: the conversation's provider session ID. */
  readonly sessionId: string;
  /**
   * The instance on its worker, a new one each time it opens, so that an instance left behind,
   * such as one still shutting down after the time limit, never reaches a later one.
   */
  #route = "";
  /** What the extensions registered as model providers. */
  readonly providers: ConversationProviders;
  readonly models: Models;
  readonly #options: AttachOptions;
  #hosted: HostedWorker | undefined;
  #release: (() => void) | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  readonly #installation: Installation;
  readonly #workers: Workers;
  #opening = false;
  /** The extensions that loaded at the last opening, by module, each with its source. */
  #loaded: ReadonlyMap<string, string> | undefined;
  /** The extensions being opened, which hooks and calls wait for. */
  #ready: Promise<unknown> = Promise.resolve();
  /**
   * The latest run that answered, by its generation, and when its end has reached the extensions,
   * which `close` waits for.
   */
  #runEnd: { taskId: TaskId; delivered: PromiseWithResolvers<void> } | undefined;
  /**
   * The `session_compact_failed` error of a truncated answer after an overflow compaction, by the
   * generation that answered, told after its `agent_end`, as Pi checks after the run.
   */
  #recoveryFailed: { taskId: TaskId; message: AssistantMessage } | undefined;
  /** What the extensions registered, as last read. */
  registrations: Registrations = { tools: [], events: [] };
  /** The extensions' writes to the conversation so far, which a read waits for. */
  #writes: Promise<void> = Promise.resolve();
  /** The model tools being set, which the next selection waits for. */
  #activation: Promise<void> = Promise.resolve();
  /** Commands `pi.exec` runs, by the ID the worker gave them, to cancel when their signal aborts. */
  readonly #execs = new Map<number, AbortController>();
  /**
   * The `session_compact` and `session_compact_failed` events under way, which the next request
   * and `close` wait for.
   */
  #compactions: Promise<void> = Promise.resolve();
  /** Aborted once the extensions are closed, which ends the waits for their handlers. */
  readonly #ended = new AbortController();
  /**
   * The compactions this conversation's `session_before_compact` handlers cancelled, until they are
   * `terminal`, for `session_compact_failed`.
   */
  readonly #declined = new Set<TaskId>();
  /**
   * The compactions whose summary this conversation's `session_before_compact` handlers supplied,
   * until they are `terminal`, for `session_compact_failed`'s `fromExtension`.
   */
  readonly #supplied = new Set<TaskId>();
  /** What the session shows of each compaction besides its entry, which only a context read tells. */
  readonly #measured = new Map<EntryId, Measured>();

  /** The conversation these extensions are attached to. */
  get conversation(): Conversation {
    return this.#options.conversation;
  }

  /** The conversation these extensions act for. */
  get conversationId(): ConversationId {
    return this.#options.conversation.id;
  }

  constructor(
    sessionId: string,
    options: AttachOptions,
    installation: Installation,
    workers: Workers,
  ) {
    this.sessionId = sessionId;
    this.models = options.models;
    this.#options = options;
    this.#installation = installation;
    this.#workers = workers;
    this.providers = new ConversationProviders(
      options.models,
      sessionId,
      options.harness,
      options.conversation.id,
      async (context) => this.#awaitCompactionHandlers(context),
    );
  }

  /**
   * Waits for the compaction handlers under way, until the extensions close. Its listener goes
   * with each wait, as one per request on a pending promise would stay until the close.
   */
  async #awaitCompactionHandlers(context: Context) {
    const ended = this.#ended.signal;
    if (ended.aborted) return;
    const closed = Promise.withResolvers<void>();
    const onEnded = () => closed.resolve();
    ended.addEventListener("abort", onEnded, { once: true });
    try {
      await awaitWithContext(Promise.race([this.#compactions, closed.promise]), context);
    } finally {
      ended.removeEventListener("abort", onEnded);
    }
  }

  /** Whether the extensions are loading on a worker. */
  get opening() {
    return this.#opening;
  }

  get closing() {
    return this.#closing !== undefined;
  }

  get #rpc() {
    if (this.#closed) throw new Error("The conversation's extensions are closed");
    if (!this.#hosted) throw new Error("The conversation's extension worker exited");
    return this.#hosted.rpc;
  }

  /**
   * Whether the extensions still run: not once closed, nor once their worker exited, when their
   * hooks do nothing rather than fail every request; `beforeTool` decides for itself.
   */
  get #running() {
    return !this.#closed && this.#hosted !== undefined;
  }

  /**
   * Starts the extensions on a worker: loads them, runs `session_start`, and installs what they
   * registered. Hooks and tool calls wait for it.
   */
  open(context: Context): Promise<Opened> {
    const route = `${this.sessionId}#${++openings}`;
    const hosted = this.#workers.acquire(route, this);
    this.#route = route;
    this.#hosted = hosted;
    this.providers.bind({ rpc: hosted.rpc, requests: hosted.requests, route });
    this.#release = () => this.#workers.release(hosted, route, this);
    this.#opening = true;
    // Its own awaits stop at the limit too.
    const limit = AbortSignal.timeout(STUCK_AFTER_MS);
    const limited = withAbortSignal(limit, context);
    const loading = this.#open(hosted, route, limited).finally(() => {
      this.#opening = false;
      // Closed, or given up on, while loading: the instance goes when it is done.
      if (this.#closed || this.#hosted !== hosted) void hosted.rpc.close(route).catch(() => {});
    });
    const opened = awaitWithContext(loading, limited).catch((error: unknown) => {
      // Named, so a caller tells a stuck extension from its own deadline, which a timeout signal
      // reports with the same message.
      if (!limit.aborted || context.abortSignal?.aborted) throw error;
      throw new Error(`Opening the extensions took longer than ${STUCK_AFTER_MS} ms`, {
        cause: error,
      });
    });
    this.#ready = opened.catch(() => {});
    return opened;
  }

  async #open(hosted: HostedWorker, route: string, context: Context): Promise<Opened> {
    const { conversation, cwd, flags } = this.#options;
    const reopening = this.#loaded !== undefined;
    const opened = await hosted.rpc.open(route, this.sessionId, cwd, flags ?? {});
    this.#stillOn(hosted);
    // At attach the errors are the attachment's. Opened again, nobody reads those, so Pi's
    // failures binding an extension that loaded, such as a provider registration it refused, are
    // reported as a handler's, also when another extension's failure fails the reopen below.
    if (reopening) {
      for (const error of opened.errors)
        if ("event" in error) this.#workers.report(error, conversation.id);
    }
    // Opened again, the extensions keep the tools and hooks they registered before, a `tool_call`
    // gate included, until they are all back: one that loaded before and fails now fails the
    // reopen. Their providers went at the exit and are registered again as at attach.
    const loaded = new Map(opened.loaded.map((each) => [each.path, each.source]));
    for (const [module, source] of this.#loaded ?? []) {
      if (loaded.has(module)) continue;
      const reason = opened.errors.find((each) => each.source === source)?.message;
      throw new Error(`Extension "${source}" failed to load again: ${reason ?? "not loaded"}`);
    }
    this.#loaded = loaded;
    if (!reopening) this.update(opened);
    // Opened again after its worker's exit, or a conversation with entries after a restart, as
    // Pi tells extensions about a session it opens again.
    const earlier = await conversation.entries({ order: "ascending" }, 1, undefined, context);
    const reason = reopening || earlier.items.length > 0 ? "resume" : "startup";
    await hosted.rpc.emit(route, { type: "session_start", reason });
    const registrations = await hosted.rpc.registrations(route);
    this.#stillOn(hosted);
    // Extensions often register tools in `session_start`; they are installed before the first request.
    this.update(registrations);
    return opened;
  }

  /** Fails a loading that its conversation gave up on, so it installs nothing. */
  #stillOn(hosted: HostedWorker) {
    if (this.#hosted !== hosted) throw new Error("The extensions stopped loading on this worker");
  }

  /** Opens the extensions again on another worker after theirs exited. */
  async reopen() {
    try {
      await this.open(BACKGROUND_CONTEXT);
    } catch (error) {
      // On a worker that is still running, its instance and its place go, and the conversation is
      // lost as on an exit.
      void this.#hosted?.rpc.close(this.#route).catch(() => {});
      this.#release?.();
      this.lost(ensureError(error));
      throw error;
    }
  }

  get id() {
    return this.#options.conversation.id;
  }

  /** Takes the extensions' current registrations, and installs them in the registry. */
  update(registrations: Registrations) {
    // From the start of closing: an opening given up on can still finish loading, and its
    // registrations would install the extension again after the conversation left.
    if (this.#closing) return;
    this.registrations = registrations;
    this.#installation.refresh(this);
  }

  async beforeTool(call: ToolHookCall, context: Context) {
    await awaitWithContext(this.#ready, context);
    if (this.#closed) return undefined;
    // Extensions that gate tool calls block them once their worker exited, as Pi blocks a call
    // when a `tool_call` handler fails (`agent-session.js`); without a gate, calls go on.
    if (!this.#hosted) {
      if (!this.#listens("tool_call")) return undefined;
      return { block: "Extension failed, blocking execution: the extension worker exited" };
    }
    const { result, input } = await this.#rpc.toolCall(this.#route, {
      type: "tool_call",
      toolCallId: call.id,
      toolName: call.name,
      input: structuredClone(call.arguments),
    });
    if (result?.block) return { block: result.reason ?? "Blocked by an extension" };
    const changed = toJson(input);
    if (changed === undefined || isDeepStrictEqual(changed, call.arguments)) return undefined;
    return Guard.IsObjectNotArray(changed) ? { arguments: changed } : undefined;
  }

  async afterTool(call: ToolHookCall, result: ToolExecutionResult, context: Context) {
    await awaitWithContext(this.#ready, context);
    if (!this.#running) return undefined;
    const changed = await this.#rpc.toolResult(this.#route, {
      type: "tool_result",
      toolCallId: call.id,
      toolName: call.name,
      input: call.arguments,
      content: [...(result.output ?? [])],
      details: result.details,
      isError: result.isError ?? false,
    });
    if (!changed) return undefined;
    return {
      ...result,
      ...(changed.content !== undefined && { output: changed.content }),
      ...withDetails(changed.details),
      ...(changed.isError !== undefined && { isError: changed.isError }),
    };
  }

  /** Whether this conversation's extensions listen to any of `events`. */
  #listens(...events: string[]) {
    return events.some((event) => this.registrations.events.includes(event));
  }

  /**
   * Before each request: a run's first request starts it as Pi's agent does, each attempt starts
   * a turn, and `context` handlers change what the request sends. pi-durable has no
   * hook where a run starts, so its first request stands for it: `LiveRun.turns` counts the run's
   * tool rounds, and a retry is a later attempt of the same request.
   */
  async beforeRequest(
    request: { readonly messages: readonly Message[] },
    api: HookApi,
    context: Context,
  ) {
    await awaitWithContext(this.#ready, context);
    // As Pi's agent goes on once the handlers are done, so a provider that keeps a query open
    // across tool rounds hears of a compaction before the request that follows it. Direct
    // requests to the extensions' providers wait as well (`ConversationProviders`).
    await this.#awaitCompactionHandlers(context);
    if (!this.#running) return undefined;
    let messages = [...request.messages];
    if (this.#listens("before_agent_start", "agent_start", "turn_start")) {
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const run = live?.run;
      if (run?.turns === 0 && this.#listens("before_agent_start", "agent_start")) {
        const started = await this.#startRun(run, messages, api, context);
        if (started) {
          await this.#keepSections(run, started.sections, api, context);
          messages = [...messages, ...started.sent.map(sentMessage)];
        }
      }
      // Each attempt, a retry too, as each response ends a turn; Pi's retry also ends the run and
      // starts it again (`agent_end`, `agent_start`), which here it stays.
      if (run && this.#listens("turn_start")) {
        await this.#rpc.emit(this.#route, {
          type: "turn_start",
          turnIndex: run.turns,
          timestamp: Date.now(),
        });
      }
      const kept = await api.snapshot(RunSections, api.conversationId, context);
      if (run?.first !== undefined && kept?.run === run.first) {
        messages = withSections(messages, kept.sections);
      }
    }
    if (this.#listens("context", "context_with_system")) {
      messages = await this.#rpc.context(this.#route, messages);
    }
    return { messages };
  }

  /**
   * Runs `before_agent_start` and `agent_start` once for the run, recording what they return as a
   * memo of the run's first generation task, which every attempt of its request reads: a retry,
   * or the attempt after a crash, sends the same additions without running the handlers again.
   * The messages they return are also written to the conversation, where they land at its next
   * boundary, after this request's answer. A run with no new start, see `#runTrigger`, runs none.
   */
  async #startRun(
    run: LiveRun,
    messages: readonly Message[],
    api: HookApi,
    context: Context,
  ): Promise<RunStart | undefined> {
    const memo = "pi-durable-extension-adapter.agentStart";
    const done = await api.memo<JsonValue>(memo, context);
    if (done !== undefined) {
      Value.Assert(RunStart, done);
      return done;
    }
    const trigger = await this.#runTrigger(run, messages, api, context);
    if (!trigger) return undefined;
    const { conversation, cwd } = this.#options;
    const { tools } = await conversation.agent(context);
    const started = await this.#rpc.agentStart(
      this.#route,
      trigger,
      cwd,
      tools.map((tool) => tool.name),
    );
    const recorded: RunStart = {
      sections: started.sections,
      sent: started.messages.map((message) => message.content),
    };
    // The first value recorded wins, should two attempts ever run the handlers at once.
    const kept = await api.memo<JsonValue>(memo, toJson(recorded) ?? null, context);
    for (const message of started.messages) this.act({ type: "sendMessage", args: [message] });
    if (started.selection) this.act({ type: "setActiveTools", ...started.selection });
    Value.Assert(RunStart, kept);
    return kept;
  }

  /**
   * Stores the sections a run's start added, for its later rounds, which are generation tasks of
   * their own that a host restarted meanwhile runs too. Before the request, so that a crash after
   * it cannot lose them: an attempt after the crash reads the memo and stores them then; storing
   * the same value again changes nothing, and pi-durable stores no empty commit.
   *
   * A hook's `api` only reads, so it commits through the conversation, as the host does from
   * outside its tasks; the commit does not wait for the generation task the hook runs in.
   */
  async #keepSections(
    run: LiveRun,
    sections: Readonly<Record<string, string>>,
    api: HookApi,
    context: Context,
  ) {
    if (run.first === undefined) return;
    const value = { run: run.first, sections: { ...sections } };
    await this.#options.conversation.commit(async (tx) => {
      Object.assign(await tx.doc(RunSections, api.conversationId), value);
    }, context);
  }

  /**
   * What started the run, as Pi's `before_agent_start` describes it: the oldest of the inputs
   * pi-durable placed for it, so not a message written meanwhile or a compaction's summary. One an
   * extension sent with `triggerTurn` is a custom message, any other a prompt. Pi's trigger is a
   * single message, so later inputs of the same run are not described. None, so no new start, for
   * two kinds of first request: an `onYield` continuation of the run, which appends a prompt after
   * its inputs, as Pi's `continue` starts nothing; and a `continue` after a failure, which has no
   * input of its own to describe.
   */
  async #runTrigger(
    run: LiveRun,
    messages: readonly Message[],
    api: HookApi,
    context: Context,
  ): Promise<AgentStartTrigger | undefined> {
    const { harness } = this.#options;
    const placed = await Promise.all(
      run.inputs.map(async (id) => (await harness.submission(id, context))?.status(context)),
    );
    const entries = placed.flatMap((each) =>
      each?.type === "input" && each.entry ? [each.entry] : [],
    );
    const [oldest] = entries;
    if (oldest === undefined) {
      return run.inputs.length > 0 ? undefined : userTrigger(newestUserContent(messages));
    }
    if (await userEntryAfter(entries, api, context)) return undefined;
    const record = await api.entry(oldest, context);
    const message = record?.model?.find((each) => each.role === "user");
    if (!record || !message) return userTrigger(newestUserContent(messages));
    if (!record.kind.startsWith("piext.")) return userTrigger(message.content);
    const data = Guard.IsObjectNotArray(record.data) ? record.data : {};
    return {
      messageType: "custom",
      message: {
        role: "custom",
        customType: record.kind.slice("piext.".length),
        content: message.content,
        display: data.display !== false,
        ...(data.details !== undefined && { details: data.details }),
        timestamp: message.timestamp,
      },
    };
  }

  /**
   * After each response, a failed attempt's too: `message_end`, and for one that calls no tool,
   * `turn_end`, as Pi ends a turn at an answer or an error. It comes before the answer is
   * committed, so it has no entry ID; and here rather than in `onYield`, which pi-durable stops
   * calling once another extension's hook continues the run.
   */
  async afterResponse(message: AssistantMessage, api: HookApi, context: Context) {
    await awaitWithContext(this.#ready, context);
    if (!this.#running) return;
    if (this.#listens("message_end")) await this.#rpc.messageEnd(this.#route, message);
    // A tool round's `turn_end` comes from `afterTools`; pi-durable starts one only for a response
    // with calls, and takes one without as an answer.
    const round =
      message.stopReason === "toolUse" && message.content.some((part) => part.type === "toolCall");
    if (!round && this.#listens("turn_end")) {
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      await this.#rpc.turnEnd(this.#route, {
        type: "turn_end",
        turnIndex: live?.run?.turns ?? 0,
        message,
        toolResults: [],
        messageEntryId: "",
        toolResultEntryIds: [],
        outcome:
          message.stopReason === "error" || message.stopReason === "aborted"
            ? message.stopReason
            : "completed",
      });
    }
    if (!this.#listens("session_compact_failed")) return;
    // After the turn, as Pi checks once the run is over.
    const errorMessage = await this.#recoveryFailure(message, api, context);
    if (errorMessage === undefined) return;
    // pi-durable fails a run on the error; a truncated answer ends it, after `agent_end`.
    if (message.stopReason === "length") this.#recoveryFailed = { taskId: api.taskId, message };
    else this.#queueCompactionEvent(async () => recoveryFailed(errorMessage));
  }

  /** `turn_end` for a tool round, from the committed entries: the hook's `results` can be empty. */
  async turnEnd(assistant: EntryId, api: HookApi, context: Context) {
    await awaitWithContext(this.#ready, context);
    if (!this.#running) return;
    const live = await api.snapshot(LiveDoc, api.conversationId, context);
    const [first, ...rest] = await records(api, { minEntryId: assistant }, context);
    const message = first?.model?.find((each) => each.role === "assistant");
    if (!first || !message) return;
    const results = rest.flatMap((record) =>
      (record.model ?? []).flatMap((each) =>
        each.role === "toolResult" ? [{ id: `${record.id}`, message: each }] : [],
      ),
    );
    await this.#rpc.turnEnd(this.#route, {
      type: "turn_end",
      // The round is counted before its `afterTools` hooks run.
      turnIndex: Math.max(0, (live?.run?.turns ?? 1) - 1),
      message,
      toolResults: results.map((each) => each.message),
      messageEntryId: `${first.id}`,
      toolResultEntryIds: results.map((each) => each.id),
      outcome: "completed",
    });
  }

  /**
   * `agent_end` with the run's messages, then `agent_settled`, as Pi ends a run; pi-durable has no
   * hook for a run that fails or aborts.
   */
  async agentEnd(run: RunSummary, api: HookApi, context: Context) {
    // A truncated answer's `session_compact_failed` is queued from the start, so requests from now
    // on wait for its handlers, and told after `agent_end`, once checked again where Pi checks.
    const failed = this.#recoveryFailed?.taskId === api.taskId ? this.#recoveryFailed : undefined;
    const told = Promise.withResolvers<SessionCompactFailedEvent | undefined>();
    if (failed) {
      this.#recoveryFailed = undefined;
      this.#queueCompactionEvent(() => told.promise);
    }
    try {
      await awaitWithContext(this.#ready, context);
      if (!this.#running) return;
      if (this.#listens("agent_end")) {
        const range = await records(api, { minEntryId: run.first, maxEntryId: run.last }, context);
        const messages = range.flatMap((record) => record.model ?? []);
        await this.#rpc.emit(this.#route, { type: "agent_end", messages });
      }
      if (failed) {
        const applies = await this.#recoveryApplies(failed.message, context).catch(() => undefined);
        told.resolve(applies && recoveryFailed(TRUNCATED_AGAIN));
        // Until the extensions close, as for a request.
        await this.#awaitCompactionHandlers(context);
        if (!this.#running) return;
      }
      // A run that answered was not aborted.
      if (this.#listens("agent_settled")) {
        await this.#rpc.emit(this.#route, { type: "agent_settled", aborted: false });
      }
    } finally {
      told.resolve(undefined);
      this.#runEndOf(api.taskId).delivered.resolve();
    }
  }

  /** The end of the run whose generation is `taskId`, started on first use; only the latest is kept. */
  #runEndOf(taskId: TaskId) {
    if (this.#runEnd?.taskId !== taskId) {
      this.#runEnd = { taskId, delivered: Promise.withResolvers() };
    }
    return this.#runEnd;
  }

  /**
   * Notes what pi-durable's summary entry has no place for of every compaction (`CompactionNotes`),
   * and runs `session_before_compact`: a cancel declines the compaction, and a compaction of a
   * handler's own replaces pi-durable's summary, once what it carries besides is noted too.
   */
  async beforeCompact(
    compaction: {
      readonly reason: CompactionReason;
      readonly entries: readonly EntryRecord[];
      readonly messages: readonly Message[];
      readonly firstKept: EntryId;
      readonly instructions?: string;
    },
    api: HookApi,
    context: Context,
  ) {
    await awaitWithContext(this.#ready, context);
    // The whole context, as Pi's estimate, which the hook's `messages`, those to summarize, are not
    // all of: as pi-durable read it just before its hooks, unless an earlier hook waited while an
    // entry landed.
    const { messages } = await this.#options.conversation.context(context);
    const tokensBefore = estimateContextTokens(messages).tokens;
    const decision =
      this.#running && this.#listens("session_before_compact")
        ? await this.#rpc.beforeCompact(this.#route, {
            reason: compaction.reason,
            instructions: compaction.instructions,
            firstKept: `${compaction.firstKept}`,
            messages: compaction.messages.filter((message) => message.role !== "system"),
            entries: await this.#entries(),
            tokensBefore,
            willRetry: willRetry(compaction.reason),
          })
        : undefined;
    // pi-durable takes the first decision and asks no later hook.
    if (decision && "decline" in decision) {
      if (this.#listens("session_compact_failed")) this.#declined.add(api.taskId);
      return decision;
    }
    // Before the note, so an abort while it is written still tells who supplied the summary.
    if (decision && this.#listens("session_compact_failed")) this.#supplied.add(api.taskId);
    await this.#keepNote(
      compaction.firstKept,
      tokensBefore,
      decision && {
        hash: summaryHash(decision.summary),
        supplied: {
          tokensBefore: decision.tokensBefore,
          ...(decision.details !== undefined && { details: decision.details }),
          ...(decision.usage !== undefined && { usage: decision.usage }),
        },
      },
      context,
    );
    return decision && { summary: decision.summary };
  }

  /**
   * Notes what the compaction that keeps the entries from `firstKept` on tells, before pi-durable
   * places its summary: the context's size, and what a handler's compaction carried, under its
   * summary's hash, beside other summaries' at the same cut. A commit that fails is reported, and
   * the summary is placed without it.
   */
  async #keepNote(
    firstKept: EntryId,
    tokensBefore: number,
    summary: { readonly hash: string; readonly supplied: Supplied } | undefined,
    context: Context,
  ) {
    const { conversation } = this.#options;
    try {
      await conversation.commit(async (tx) => {
        const { notes } = await tx.doc(CompactionNotes, conversation.id);
        const key = `${firstKept}`;
        notes[key] = {
          tokensBefore,
          summaries: {
            ...notes[key]?.summaries,
            ...(summary && { [summary.hash]: summary.supplied }),
          },
        };
      }, context);
    } catch (error) {
      // An abort is the compaction's: pi-durable's abort handling takes it.
      context.abortSignal?.throwIfAborted();
      this.#reportFailure("session_before_compact", error);
    }
  }

  /** Reports a failure of the adapter's own in handling `event`, which goes on without it. */
  #reportFailure(event: string, error: unknown) {
    // ensure-error assigns to an Error's cause, which throws on a frozen one.
    const failure = error instanceof Error ? error : ensureError(error);
    this.#workers.report(
      {
        source: "<runtime>",
        event,
        message: failure.message,
        ...(failure.stack !== undefined && { stack: failure.stack }),
      },
      this.conversationId,
    );
  }

  /**
   * Follows the compactions a commit stored for the conversation: `session_compact` for each summary
   * pi-durable placed, as Pi gives it once a compaction is written, and `session_compact_failed`
   * for each compaction that ended without one (`#followEnd`) or whose summary pi-durable dropped
   * (`#followPlacement`). Task ends first, as a commit's changes come in no order and an idle
   * conversation settles a summary's write in the commit that ends its compaction.
   */
  followCompactions(changes: readonly StoredChange[]) {
    if (this.#closing) return;
    for (const change of changes) {
      if (change.type === "task") this.#followEnd(change.value, changes);
    }
    for (const change of changes) {
      if (change.type === "submission") this.#followPlacement(change.value);
      if (change.type !== "entry" || !CompactionEntry.is(change.value)) continue;
      if (!this.#listens("session_compact")) continue;
      const entry = change.value;
      this.#queueCompactionEvent(async () => {
        const compactionEntry = await this.#shownCompaction(entry);
        const { reason } = entry.data;
        return {
          type: "session_compact",
          compactionEntry,
          fromExtension: compactionEntry.fromHook === true,
          reason,
          willRetry: willRetry(reason),
        };
      });
    }
  }

  /**
   * `session_compact_failed`, once, for a compaction task that ended without a summary, as Pi gives
   * it: for a cancel by this conversation's handlers or an abort, with `aborted`; for a failure,
   * with the error `pi.live` records in the commit that ends the compaction; and for a manual
   * compaction with nothing to compact, with Pi's error for that. A task with children left ends
   * `completing`, and `terminal` once they end; a fault the scheduler writes is recorded only then.
   * So it is told at the first of the two that has it, and which were told is kept until
   * `terminal`, for a conversation attached again in between (`CompactionTracking`). An automatic compaction with
   * nothing to compact has no event, as in Pi. One that an app's own pi-durable hook declines ends
   * the same way here, so it is told as one with nothing to compact.
   */
  #followEnd(task: StoredTask, changes: readonly StoredChange[]) {
    if (task.kind !== CompactionTask.definition.name) return;
    const { state } = task;
    if (state.status !== "completing" && state.status !== "terminal") return;
    const terminal = state.status === "terminal";
    const declined = this.#declined.has(task.id);
    const fromExtension = this.#supplied.has(task.id);
    const { told, placing } = this.#installation.compactions;
    if (terminal) {
      this.#declined.delete(task.id);
      this.#supplied.delete(task.id);
      if (told.delete(task.id)) return;
    } else if (told.has(task.id)) return;
    if (!this.#listens("session_compact_failed")) return;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the compaction task's own input
    const { reason } = task.input as CompactionInput;
    const failed = (
      fields: () => Promise<Pick<SessionCompactFailedEvent, "aborted" | "errorMessage">>,
    ) => {
      if (!terminal) told.add(task.id);
      this.#queueCompactionEvent(async () => ({
        type: "session_compact_failed",
        reason,
        ...(await fields()),
        // Pi retries no request after a compaction that failed.
        willRetry: false,
        fromExtension,
      }));
    };
    const { outcome } = state;
    if (outcome.status === "aborted" || (declined && outcome.status === "completed")) {
      failed(async () => ({ aborted: true }));
      return;
    }
    if (outcome.status === "completed") {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the compaction task's own result
      const { entryId, submissionId } = outcome.result as CompactionResult;
      // A summary placed, or waiting to be.
      if (entryId !== undefined) return;
      if (submissionId !== undefined) {
        // Once: at `terminal` after `completing`, its write may have settled already.
        if (!terminal) told.add(task.id);
        placing.set(submissionId, { reason, fromExtension });
        return;
      }
      if (reason !== "manual") return;
      // Read as the task ends, rather than once the events before it are done, though not in the
      // observer's callback, where pi-durable's Session APIs may not be called.
      const newest = Promise.resolve()
        .then(async () => (await this.#newest()).shown)
        .catch(() => undefined);
      failed(async () => ({
        aborted: false,
        errorMessage: `${COMPACTION_FAILED.manual}: ${
          (await newest)?.type === "compaction"
            ? "Already compacted"
            : "Nothing to compact (session too small)"
        }`,
      }));
      return;
    }
    const live = changes.find((change) => change.type === "document");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `pi.live` at the version this Harness runs (`isStored`)
    const failure = (live?.value as LiveState | undefined)?.compactionFailure;
    // None yet, as for a fault while children are left, or none pi-durable counts as a failure,
    // such as an abort whose abort was cut off.
    if (!failure || failure.taskId !== task.id) return;
    failed(async () => ({
      aborted: false,
      errorMessage: `${COMPACTION_FAILED[failure.trigger]}: ${failure.error}`,
    }));
  }

  /**
   * `session_compact_failed` for a summary waiting in a write submission that pi-durable settled
   * without placing it: a later compaction or a reset moved the context past its cut first, so it
   * went stale. Pi always places a summary its compaction produced, so the error is the adapter's.
   */
  #followPlacement(submission: StoredSubmission) {
    const tracked = this.#installation.compactions.placing;
    const placing = tracked.get(submission.id);
    if (!placing || submission.status === "queued") return;
    tracked.delete(submission.id);
    if (submission.status !== "unanswered" || !this.#listens("session_compact_failed")) return;
    const { reason, fromExtension } = placing;
    this.#queueCompactionEvent(async () => ({
      type: "session_compact_failed",
      reason,
      errorMessage: `${COMPACTION_FAILED[reason]}: ${
        submission.reason === "stale"
          ? "The summary was not placed, as a later compaction or a reset came first"
          : `The summary was not placed (${submission.reason})`
      }`,
      aborted: false,
      willRetry: false,
      fromExtension,
    }));
  }

  /**
   * Pi's error for a response that, after the compaction its request's overflow started, still
   * overflows the context or is cut off below the model's output limit, which Pi tries once to
   * recover from (`AgentSession._checkCompaction`); none for any other. As there, the response is
   * one of the conversation's current model, neither aborted nor a complete answer, and automatic
   * compaction is on. The generation that waited for that compaction keeps it in the checkpoint it
   * sends, or polls, from.
   */
  async #recoveryFailure(message: AssistantMessage, api: HookApi, context: Context) {
    if (message.stopReason !== "error" && message.stopReason !== "length") return undefined;
    const { harness } = this.#options;
    const task = await harness.getTask(api.taskId, context);
    if (task?.state.status !== "running") return undefined;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the generation task's own checkpoint
    const checkpoint = task.state.checkpoint as GenerationCheckpoint;
    if (!("compacted" in checkpoint) || checkpoint.compacted === undefined) return undefined;
    const compaction = await harness.getTask(checkpoint.compacted, context);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the compaction task's own input
    if ((compaction?.input as CompactionInput | undefined)?.reason !== "overflow") return undefined;
    const model = await this.#recoveryApplies(message, context);
    if (!model) return undefined;
    const overflow =
      (message.stopReason === "error" && isContextOverflow(message)) ||
      isContextOverflow(message, model.contextWindow);
    if (overflow) return OVERFLOW_AGAIN;
    return isRecoverableLength(message, model.maxTokens) ? TRUNCATED_AGAIN : undefined;
  }

  /**
   * The model of a response Pi checks for a failed recovery, if it does: one of the conversation's
   * current model, newer than its latest compaction, while its compaction setting is not off.
   */
  async #recoveryApplies(message: AssistantMessage, context: Context) {
    const { conversation, models } = this.#options;
    const agent = await conversation.agent(context);
    const ref = agent.model;
    if (ref?.provider !== message.provider || ref.modelId !== message.model) return undefined;
    // pi-durable's `compactionPolicy`, which it does not export, so far as the conversation's own
    // settings decide; the harness's are the app's, which the adapter cannot read.
    const own = agent.compaction?.modelOverrides?.[`${ref.provider}/${ref.modelId}`]?.enabled;
    if ((own ?? agent.compaction?.enabled) === false) return undefined;
    // The latest compaction is the context's head marker, at the time the session shows for it.
    const { head } = await conversation.context(context);
    if (head && message.timestamp <= placedAt(head)) return undefined;
    return models.getModel(ref.provider, ref.modelId);
  }

  /**
   * Queues a compaction event, built once the ones before it are done; the next request and `close`
   * wait for its handlers.
   */
  #queueCompactionEvent(
    event: () => Promise<SessionCompactEvent | SessionCompactFailedEvent | undefined>,
  ) {
    this.#compactions = this.#compactions.then(async () => {
      try {
        // Opened again after a worker exit, the reopened extensions get it.
        await this.#ready;
        if (!this.#running) return;
        const built = await event();
        if (built) await this.#rpc.emit(this.#route, built);
      } catch {
        // The worker exited or the conversation closed meanwhile, which ends its extensions'
        // session too; Pi's runner reports a failing handler itself.
      }
    });
  }

  /**
   * The compaction entry as `ctx.sessionManager` shows it, from the entries just before it alone.
   * One whose session cannot be read, as when the Harness closes meanwhile, is reported, and given
   * with what its entry alone has.
   */
  async #shownCompaction(
    entry: TypedEntry<{ reason: CompactionReason }>,
  ): Promise<SessionCompactionEntry> {
    try {
      const { harness, conversation } = this.#options;
      const notes = await harness.snapshot(CompactionNotes, conversation.id, BACKGROUND_CONTEXT);
      const { record, shown } = await this.#newest(entry.id);
      const note = entry.head === undefined ? undefined : notes?.notes[`${entry.head}`];
      const measured = await this.#measure(entry, record);
      return compactionSessionEntry(entry, shown?.id ?? null, note, measured);
    } catch (error) {
      this.#reportFailure("session_compact", error);
    }
    return compactionSessionEntry(entry, null, undefined, undefined);
  }

  /**
   * The newest entry before `below`, or of all without it: its record, and the newest entry the
   * session shows, read a page at a time from the newest rather than the whole history.
   */
  async #newest(below?: EntryId): Promise<{ record?: EntryRecord; shown?: SessionEntry }> {
    const newest = paged(
      (limit, cursor) =>
        this.#options.conversation.entries(
          { order: "descending", ...(below !== undefined && { maxEntryId: below }) },
          limit,
          cursor,
          BACKGROUND_CONTEXT,
        ),
      NEWEST_PAGE,
    );
    let record: EntryRecord | undefined;
    for await (const each of newest) {
      if (each.id === below) continue;
      record ??= each;
      const shown = CompactionEntry.is(each)
        ? compactionSessionEntry(each, null, undefined, undefined)
        : sessionEntries(each, null, "").at(-1);
      if (shown) return { record, shown };
    }
    return { record };
  }

  async beforeProviderRequest(request: { readonly payload: unknown }, context: Context) {
    await awaitWithContext(this.#ready, context);
    if (!this.#running) return undefined;
    return { payload: await this.#rpc.providerRequest(this.#route, request.payload) };
  }

  async executeTool(name: string, args: unknown, callId: string, context: Context) {
    await awaitWithContext(this.#ready, context);
    context.abortSignal?.throwIfAborted();
    const abort = () => void this.#hosted?.rpc.cancelTool(this.#route, callId);
    context.abortSignal?.addEventListener("abort", abort, { once: true });
    try {
      return toolOutput(await this.#rpc.executeTool(this.#route, callId, name, args));
    } finally {
      context.abortSignal?.removeEventListener("abort", abort);
    }
  }

  /** Reads the extensions' registrations again after they changed, and installs them. */
  reloadRegistrations() {
    // While opening, `open` reads them once its `session_start` handlers are done.
    if (this.#closed || !this.#hosted || this.#opening) return;
    void this.#hosted.rpc.registrations(this.#route).then(
      (registrations) => this.update(registrations),
      // The worker exited or the conversation closed meanwhile; its tools fail from then on.
      () => {},
    );
  }

  /**
   * Starts an extension's action. A later read waits for the ones that write to the conversation;
   * not for an abort or a compaction, which wait for the conversation's work, a tool call in this
   * worker included, and would never end while the worker waits for the read.
   */
  act(action: Action) {
    if (this.#closed) return;
    const started = this.#act(action);
    if (!started) return;
    // A failure, such as a conversation that closed meanwhile, is dropped: the extension that
    // acted has gone on, and nothing it could do would change it.
    // Settled to nothing, so the chain keeps no write's result.
    const settled = started.then(
      () => {},
      () => {},
    );
    if (action.type !== "abort" && action.type !== "compact") {
      this.#writes = Promise.all([this.#writes, settled]).then(() => {});
    }
  }

  #act(action: Action): Promise<unknown> | undefined {
    const { conversation } = this.#options;
    const context = BACKGROUND_CONTEXT;
    switch (action.type) {
      case "sendMessage": {
        const [message, options] = action.args;
        const content =
          typeof message.content === "string" ? message.content : [...message.content];
        const entry = {
          kind: `piext.${message.customType}`,
          ...withData({ display: message.display, details: message.details }),
        };
        if (options?.triggerTurn) {
          return conversation.submit(
            {
              type: "input",
              content,
              whenBusy: queueMode(options.deliverAs),
              entry,
            },
            context,
          );
        }
        return conversation.submit(
          {
            type: "write",
            entry: { ...entry, model: [{ role: "user", content, timestamp: Date.now() }] },
          },
          context,
        );
      }
      case "sendUserMessage": {
        // Through the extensions' `input` handlers already, in the worker.
        const [content, options] = action.args;
        return conversation.submit(
          {
            type: "input",
            content: typeof content === "string" ? content : [...content],
            whenBusy: queueMode(options?.deliverAs),
          },
          context,
        );
      }
      case "appendEntry":
        return conversation.submit(
          {
            type: "write",
            entry: { kind: `piext.${action.customType}`, ...withData(action.data) },
          },
          context,
        );
      case "setThinkingLevel":
        return conversation.configure({ thinkingLevel: action.level }, context);
      case "compact":
        return conversation.compact(action.instructions, context);
      case "abort":
        return conversation.abort(context);
      case "setActiveTools":
        // A tool registered just before is in the registrations the action carries: the worker's
        // notice of it travels on another channel, and asking the worker would wait on it while
        // it waits for this action to be done before its next read.
        this.update(action.registrations);
        return this.#setActiveTools(action.names, action.registrations);
      case "registrations":
        this.update(action.registrations);
        return undefined;
      default:
        // Session names, labels and shutdown have no counterpart here.
        return undefined;
    }
  }

  /**
   * Offers the model the tools `names` names, as Pi's active tools, from the next request: any tool
   * of the conversation's extensions, the deferred ones too. Names of no such tool are left out, as
   * Pi leaves them out. A tool registered later is offered as well unless it is deferred, as Pi
   * activates a tool on registration after a selection too (`_refreshToolRegistry`), so the
   * selection removes the tools it leaves out instead of listing the ones it keeps. Later means
   * after `registered`, the extensions' registrations when the selection was made: the registry
   * may have more by the time this runs.
   */
  #setActiveTools(names: readonly string[], registered: Registrations) {
    const { conversation } = this.#options;
    const context = BACKGROUND_CONTEXT;
    const own = extensionName(conversation.id);
    const known = new Set(registered.tools.map((tool) => tool.name));
    // One after the other, so the last selection made is the one that holds.
    const activated = this.#activation.then(async () => {
      const { extensions } = await conversation.agent(context);
      // The extensions' tools registered later stay as they are.
      const tools = extensions.flatMap((each) =>
        (each.tools ?? []).filter((tool) => each.name !== own || known.has(tool.name)),
      );
      const named = new Set(names);
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      // pi-durable offers the deferred tools in `add` and ignores the others there.
      await conversation.configure(
        {
          modelTools: {
            remove: tools.filter((tool) => !named.has(tool.name)),
            add: names.flatMap((name) => byName.get(name) ?? []),
          },
        },
        context,
      );
    });
    this.#activation = activated.catch(() => {});
    return activated;
  }

  /** Switches the conversation's model, as Pi does: only to a model with credentials. */
  async setModel(model: Model<Api>): Promise<boolean> {
    if (this.#closed || !(await this.models.getAuth(model))) return false;
    await this.#options.conversation.configure(
      { model: { provider: model.provider, modelId: model.id } },
      BACKGROUND_CONTEXT,
    );
    return true;
  }

  /**
   * Runs `pi.exec`'s command in the conversation's environment, with Pi's options: `cwd` defaults
   * to the extensions' directory, and output past `maxBuffer` bytes stops the command.
   */
  async exec(
    id: number,
    command: string,
    args: string[],
    options: Parameters<HostFunctions["exec"]>[4],
  ): Promise<ExecResult> {
    const env = this.#options.env;
    if (!env) throw new Error("No environment to run commands in");
    const controller = new AbortController();
    this.#execs.set(id, controller);
    const maxBuffer = options?.maxBuffer ?? DEFAULT_MAX_BUFFER;
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let truncated = false;
    try {
      const result = await env.exec(
        [command, ...args],
        {
          cwd: options?.cwd ?? this.#options.cwd,
          // Pi's timeout is in milliseconds, pi-durable's in seconds.
          ...(options?.timeout && options.timeout > 0 && { timeout: options.timeout / 1000 }),
          onOutput: (text, _context, info) => {
            if (truncated) return;
            const chunk = Buffer.from(text);
            const room = maxBuffer - bytes;
            bytes += chunk.length;
            // Past the limit, keep the output up to it, without a character cut in two, as Pi does.
            const kept =
              chunk.length <= room ? text : new StringDecoder().write(chunk.subarray(0, room));
            if (info.stream === "stderr") stderr += kept;
            else stdout += kept;
            if (chunk.length > room) {
              truncated = true;
              controller.abort();
            }
          },
        },
        withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
      );
      if (result.ok) {
        const code = result.value.exitCode;
        // A truncated result never reads as success, as in Pi.
        return {
          stdout,
          stderr,
          code: truncated && code === 0 ? 1 : code,
          killed: truncated,
          truncated,
        };
      }
      const killed = result.error.code === "aborted" || result.error.code === "timeout";
      return { stdout, stderr: stderr || result.error.message, code: 1, killed, truncated };
    } finally {
      if (this.#execs.get(id) === controller) this.#execs.delete(id);
    }
  }

  cancelExec(id: number) {
    this.#execs.get(id)?.abort();
  }

  async getApiKeyAndHeaders(model: Model<Api>) {
    try {
      const resolution = await this.models.getAuth(model);
      if (!resolution)
        return { ok: false as const, error: `No API key found for "${model.provider}"` };
      return {
        ok: true as const,
        ...(resolution.auth.apiKey !== undefined && { apiKey: resolution.auth.apiKey }),
        ...(resolution.auth.headers !== undefined && { headers: resolution.auth.headers }),
        ...(resolution.auth.baseUrl !== undefined && { baseUrl: resolution.auth.baseUrl }),
        ...(resolution.env !== undefined && { env: resolution.env }),
      };
    } catch (error) {
      return { ok: false as const, error: ensureError(error).message };
    }
  }

  static readonly #reads: {
    [M in keyof Reads]: (
      session: AttachedConversation,
      ...args: Parameters<Reads[M]>
    ) => ReturnType<Reads[M]> | Promise<ReturnType<Reads[M]>>;
  } = {
    flush: () => null,
    async getBranch(session, fromId) {
      const entries = await session.#entries();
      const end = fromId === undefined ? -1 : entries.findIndex((entry) => entry.id === fromId);
      return end === -1 ? entries : entries.slice(0, end + 1);
    },
    getEntries: (session) => session.#entries(),
    getEntry: async (session, id) => (await session.#entries()).find((entry) => entry.id === id),
    getLeafId: async (session) => (await session.#entries()).at(-1)?.id ?? null,
    getModel: (session) => session.#model(),
    getContextUsage: (session) => session.#contextUsage(),
    getThinkingLevel: async (session) =>
      (await session.conversation.agent(BACKGROUND_CONTEXT)).thinkingLevel,
    isIdle: async (session) =>
      (
        await session.#options.harness.snapshot(
          LiveDoc,
          session.conversation.id,
          BACKGROUND_CONTEXT,
        )
      )?.run === undefined,
    getActiveTools: async (session) =>
      (await session.conversation.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name),
    getAllTools: async (session) =>
      (await session.conversation.agent(BACKGROUND_CONTEXT)).tools.map((tool): ToolInfo => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        exposure: "direct",
        sourceInfo: {
          path: "<pi-durable>",
          source: "pi-durable",
          scope: "temporary",
          origin: "top-level",
        },
      })),
    getProvider: (session, name) => session.providers.get(name),
    async getModels(session) {
      const available = await session.models.getAvailable().then(
        (list) => list.map((each) => `${each.provider}/${each.id}`),
        () => [],
      );
      return { models: [...session.models.getModels()], available };
    },
  };

  /** Answers a worker's synchronous read after all preceding writes. */
  async read<M extends keyof Reads>({
    method,
    args,
  }: ReadRequest<M>): Promise<ReturnType<Reads[M]>> {
    await this.#writes;
    return AttachedConversation.#reads[method](this, ...args);
  }

  /** The conversation's model, from the `models` given to `attach`. */
  async #model(): Promise<Model<Api> | undefined> {
    const { model } = await this.#options.conversation.agent(BACKGROUND_CONTEXT);
    return model && this.models.getModel(model.provider, model.modelId);
  }

  /**
   * How full the conversation's context is, as pi-durable measures it to decide on compaction: the
   * newest answer's usage plus estimates of the messages after it. pi-durable also counts the system
   * entries the next request will write, which it does not expose. While no system entry follows the
   * latest compaction, or the conversation's start, the next request writes the whole system prompt
   * and every tool, as pi-durable plans it, so the tokens are unknown until then, as Pi's are after
   * a compaction; after a change to the prompt or the tools, the figure reads low by that change
   * until the next request.
   *
   * pi-durable does not export its own estimate, so pi-ai's stands in. pi-ai drops an answer's usage
   * when a message ahead of it is newer, as a compaction's summary is; pi-durable when the answer was
   * placed before the summary. They differ when an answer's request started after the summary was
   * written and before it was placed (a retry during a compaction can), when the clocks of one
   * conversation's hosts disagree, or when an application's edit places messages newer than the
   * answers after them. pi-ai then keeps an answer's usage from before a compaction, overstating the
   * context until the next answer, so an extension that compacts above a threshold may compact
   * again; or it drops a usage pi-durable keeps and estimates instead. pi-durable's own compaction
   * is unaffected.
   */
  async #contextUsage(): Promise<ContextUsage | undefined> {
    const contextWindow = (await this.#model())?.contextWindow;
    if (!contextWindow || contextWindow <= 0) return undefined;
    const { head, entries, messages } =
      await this.#options.conversation.context(BACKGROUND_CONTEXT);
    const prompted = entries.some(
      (entry) => SystemEntry.is(entry) && (head === undefined || entry.id > head.id),
    );
    if (!prompted) return { tokens: null, contextWindow, percent: null };
    const { tokens } = estimateContextTokens(messages);
    return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
  }

  /**
   * The conversation's entries as Pi's session entries, each compaction with its notes and what
   * the context before it tells.
   */
  async #entries(): Promise<SessionEntry[]> {
    const { harness, conversation } = this.#options;
    const found = await Array.fromAsync(
      paged((limit, cursor) =>
        conversation.entries({ order: "ascending" }, limit, cursor, BACKGROUND_CONTEXT),
      ),
    );
    const notes = found.some((record) => CompactionEntry.is(record))
      ? (await harness.snapshot(CompactionNotes, conversation.id, BACKGROUND_CONTEXT))?.notes
      : undefined;
    const entries: SessionEntry[] = [];
    const now = new Date().toISOString();
    for (const [index, record] of found.entries()) {
      const parentId = entries.at(-1)?.id ?? null;
      if (!CompactionEntry.is(record)) {
        entries.push(...sessionEntries(record, parentId, now));
        continue;
      }
      const note = record.head === undefined ? undefined : notes?.[`${record.head}`];
      const measured = await this.#measure(record, found[index - 1]);
      entries.push(compactionSessionEntry(record, parentId, note, measured));
    }
    return entries;
  }

  /**
   * What the context before the compaction `entry`, which ends at `before`, tells of it, kept for
   * later reads: one for each compaction the conversation shows, which never changes. Reading the
   * context at an entry takes about 0.1 to 0.2 ms with SQLite storage, so without them a read of a
   * session with 30 compactions and 180 entries took 4.9 ms, against 1.5 ms.
   */
  async #measure(entry: EntryRecord, before: EntryRecord | undefined): Promise<Measured> {
    const known = this.#measured.get(entry.id);
    if (known) return known;
    const messages = before
      ? (await this.#options.conversation.context(BACKGROUND_CONTEXT, { at: before.id })).messages
      : [];
    const systemMessage = getCurrentSystemMessage(messages);
    const measured: Measured = {
      tokensBefore: estimateContextTokens(messages).tokens,
      ...(systemMessage && { systemMessage }),
    };
    this.#measured.set(entry.id, measured);
    return measured;
  }

  async input(text: string, options: InputOptions = {}) {
    await this.#ready;
    if (this.#closed) throw new Error("The conversation's extensions are closed");
    // Lost extensions run no handlers, as their hooks run none; nor, as in Pi, is a round trip
    // made when no extension handles `input`.
    if (!this.#hosted || !this.#listens("input")) return { action: "continue" as const };
    const { harness, conversation } = this.#options;
    const live = await harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT);
    return this.#rpc.input(
      this.#route,
      text,
      options.images && [...options.images],
      options.source ?? "rpc",
      live?.run === undefined ? undefined : options.streamingBehavior,
    );
  }

  /**
   * The worker exited: until the extensions are opened again, their tools fail, their hooks do
   * nothing, and a `tool_call` gate blocks. Their providers go now, as at close, and the reopened
   * extensions register theirs again.
   */
  lost(error: Error) {
    this.providers.withdraw(error);
    this.#hosted = undefined;
    // Its end can no longer reach them, so `close` waits no longer.
    this.#runEnd?.delivered.resolve();
    // Their worker can no longer read the result, and a new one numbers its commands afresh.
    for (const each of this.#execs.values()) each.abort();
    this.#execs.clear();
  }

  /**
   * Tells the attacher that its extensions are gone for good, as `#recover` found. Returns what
   * `onLost` returns, so a rejection of an async one is caught too.
   */
  reportLost(error: Error): unknown {
    return this.#options.onLost?.(error);
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  /**
   * Waits for the end of a run that answered to reach the extensions and their handlers to return,
   * when it has not yet. `submission.wait()` resolves at the answer, before pi-durable asks the
   * `afterRun` hooks, so closing right after it would end the session before the run. Not a run
   * under way, whose end may be far off, nor queued input or child work, which `waitForIdle` covers.
   * On its own time limit, so that it leaves the shutdown handlers theirs.
   */
  async #awaitRunEnd() {
    // Without a worker, its end cannot reach them.
    if (!this.#hosted || !this.#listens(...RUN_END_EVENTS, "session_compact_failed")) return;
    const { harness, conversation } = this.#options;
    const limited = withAbortSignal(AbortSignal.timeout(STUCK_AFTER_MS), BACKGROUND_CONTEXT);
    try {
      const run = (await harness.snapshot(LiveDoc, conversation.id, limited))?.run;
      // `afterRun` is set at the answer, and its `tasks` once every hook has returned.
      if (run?.afterRun === undefined || run.afterRun.tasks !== undefined) return;
      await awaitWithContext(this.#runEndOf(run.taskId).delivered.promise, limited);
    } catch {
      // Past the limit, such as behind another extension's `afterRun` hook that waits for this
      // `close`, or with the Harness closed, the extensions close without the run's end.
    }
  }

  async #close() {
    await this.#awaitRunEnd();
    // One time limit for the loading and the compaction handlers under way and the shutdown
    // handlers.
    const limited = withAbortSignal(AbortSignal.timeout(STUCK_AFTER_MS), BACKGROUND_CONTEXT);
    await awaitWithContext(Promise.all([this.#ready, this.#compactions]), limited).catch(() => {});
    this.#installation.remove(this);
    // Its commits are no longer observed, so nothing ends these any more.
    this.#declined.clear();
    this.#supplied.clear();
    // Its provider queries end by their IDs first, so a `session_shutdown` handler that hangs
    // cannot keep them open; their registrations go with them.
    this.providers.close();
    const hosted = this.#hosted;
    if (hosted) {
      // What `session_shutdown` handlers write is kept, as the worker waits for it before it
      // answers; what extensions do after it, or after the time limit, is dropped. So is its
      // answer then, a failure too, as when the host has let go of the instance by the time it
      // flushes their writes.
      const closed = hosted.rpc.close(this.#route).catch(() => {});
      await awaitWithContext(closed, limited).catch(() => {});
      // What providers keep for the session is released all the same past the limit, as behind a
      // shutdown handler that never returns, and for an opening given up on while an extension's
      // factory hangs, which has no instance to close yet; otherwise the close released it, and
      // this does nothing. What fails is reported here, as the worker drops its reports for an
      // instance the host let go of. Awaited, so `host.close()` ends the worker only after it.
      const released = hosted.rpc.releaseSessionResources(this.#route, this.sessionId).then(
        (failures) => {
          for (const failure of failures) this.#workers.report(failure, this.conversationId);
        },
        () => {},
      );
      const bounded = withAbortSignal(AbortSignal.timeout(RELEASE_WAIT_MS), BACKGROUND_CONTEXT);
      await awaitWithContext(released, bounded).catch(() => {});
    }
    this.#closed = true;
    this.#ended.abort();
    this.#release?.();
  }
}

/**
 * How long opening a conversation's extensions, closing them, or delivering a run's end before
 * closing may take before it is given up on. Loading and the session handlers take well under a
 * second (about 180 ms on a new worker with `pi-web-access` and `pi-web-search`), and a run's end as
 * long as its handlers, such as one flushing a trace, so only a handler that hangs or runs unusually
 * long reaches it. Without a limit, such a handler would hold up `attach`, the conversation's hooks after a reopen, or the end
 * of its work and its place on the worker, until the caller's own deadline, which is sized for a
 * whole job. Pi has no limit, as a person at the terminal ends what hangs; nobody does for an
 * unattended host. It is wall time: a worker that another conversation's synchronous work keeps
 * busy that long counts too, as it holds up every conversation on it already.
 */
const STUCK_AFTER_MS = 10_000;

/**
 * How long closing waits for the worker to release a session's resources. The release runs
 * synchronously in the worker and answers within milliseconds; only a worker whose thread is
 * blocked does not answer, and then it cannot release them anyway.
 */
const RELEASE_WAIT_MS = 1_000;

/** The pi-durable extension that carries a conversation's extensions. */
function extensionName(conversation: ConversationId) {
  return `${EXTENSION_PREFIX}${conversation}`;
}

const EXTENSION_PREFIX = "pi-durable-extension-adapter:";

/** `lines` as a list in a section tagged `name`, as Pi renders its tools and rules; none if empty. */
function listSection(name: string, lines: readonly string[]) {
  if (lines.length === 0) return undefined;
  return `<${name}>\n${lines.map((line) => `- ${line}`).join("\n")}\n</${name}>`;
}

/** Whether Pi leaves a tool out of the active set when it is registered. */
function inactive({ exposure, defaultActive }: ToolDescriptor) {
  if (exposure === "codemode" || exposure === "deferred") return true;
  return defaultActive === false;
}

/** Pi's default for `pi.exec`'s `maxBuffer` (`core/exec.js`): 256 MiB, within the longest string. */
const DEFAULT_MAX_BUFFER = Math.min(256 * 1024 * 1024, constants.MAX_STRING_LENGTH);

/**
 * Pi runs a tool's `prepareArguments` before validating its arguments; pi-durable does too, but
 * synchronously on the host thread, where waiting for the worker would stall every conversation. For a tool
 * that has one, the host repairs what models commonly get wrong, an array or object sent as JSON
 * text, as pi-durable's own `edit` tool does in its `prepareArguments` (`tools/edit.js`); pi-ai's
 * coercion would wrap such text in an array instead. The worker runs the tool's own before it
 * executes.
 */
function repairArguments(args: unknown, schema: object): unknown {
  if (
    !Guard.IsObjectNotArray(args) ||
    !("properties" in schema) ||
    !Guard.IsObjectNotArray(schema.properties)
  )
    return args;
  let repaired: Record<string, unknown> | undefined;
  for (const [name, property] of Object.entries(schema.properties)) {
    const value = args[name];
    if (typeof value !== "string" || !Guard.IsObjectNotArray(property)) continue;
    const wanted = property.type;
    if (wanted !== "array" && wanted !== "object") continue;
    try {
      const parsed: unknown = JSON.parse(value);
      if (wanted === "array" ? Array.isArray(parsed) : Guard.IsObjectNotArray(parsed)) {
        repaired ??= { ...args };
        repaired[name] = parsed;
      }
    } catch {
      // Left as it is, for validation to report.
    }
  }
  return repaired ?? args;
}

/** `details`, when there are any that survive JSON. */
function withDetails(details: unknown): { details?: JsonValue } {
  const json = toJson(details);
  return json === undefined ? {} : { details: json };
}

/** `data`, when there is any that survives JSON. */
function withData(data: unknown): { data?: JsonValue } {
  const json = toJson(data);
  return json === undefined ? {} : { data: json };
}

function toolOutput(result: ToolResult) {
  return {
    output: result.content.filter(isContentPart),
    ...withDetails(result.details),
    ...(result.isError !== undefined && { isError: result.isError }),
  };
}

/** A text or image part of a message's content, as pi-ai has them. */
const ContentPart = Type.Union([
  Type.Object({ type: Type.Literal("text"), text: Type.String() }),
  Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }),
]);
const isContentPart = (value: unknown): value is Static<typeof ContentPart> =>
  Value.Check(ContentPart, value);

/** The events that end a run that answered, which its `afterRun` hook dispatches. */
const RUN_END_EVENTS = ["agent_end", "agent_settled"];

/** The events a request's hook dispatches. */
const REQUEST_EVENTS = [
  "before_agent_start",
  "agent_start",
  "turn_start",
  "context",
  "context_with_system",
];

/**
 * What a run's `before_agent_start` returned that each attempt of its first request applies: the
 * system prompt sections, and the content of the messages, which the request carries.
 */
type RunStart = Static<typeof RunStart>;
const RunStart = Type.Object({
  sections: Type.Record(Type.String(), Type.String()),
  sent: Type.Array(Type.Union([Type.String(), Type.Array(ContentPart)])),
});

/**
 * The system prompt sections the conversation's latest run start added, which each request of
 * that run sends, by the run's first entry. An `onYield` continuation is the same run, and a
 * `continue` after a failure has the failed run's first entry, so both keep them, as neither
 * starts the run again, see `#runTrigger`. A run that lacks a first entry, started before
 * pi-durable recorded it, keeps none.
 */
const RunSections = defineDoc<{ run?: EntryId; sections: Record<string, string> }>({
  kind: "pi-durable-extension-adapter.runSections",
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork has no run under way.
  fork: "initial",
  initial: () => ({ sections: {} }),
  // Small, and changed once a run at most.
  checkpointWhen: () => true,
});

/** How pi-durable queues a message an extension sends while the conversation is busy. */
function queueMode(deliverAs: string | undefined) {
  return deliverAs === "steer" ? "steer" : "followUp";
}

/**
 * The summary a compaction entry carries. pi-durable wraps it for the model as Pi does
 * (`COMPACTION_SUMMARY_PREFIX` and `COMPACTION_SUMMARY_SUFFIX` in the coding agent's
 * `core/messages.js`), which Pi keeps out of the summary it records and neither package exports;
 * text wrapped otherwise, as by another pi-durable release, is the summary whole.
 */
function compactionSummary(entry: EntryRecord) {
  const message = entry.model?.find((each) => each.role === "user");
  const text = message ? contentText(message.content) : "";
  if (!text.startsWith(SUMMARY_PREFIX) || !text.endsWith(SUMMARY_SUFFIX)) return text;
  return text.slice(SUMMARY_PREFIX.length, -SUMMARY_SUFFIX.length);
}

const SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";

/** pi-durable compacts after an overflow only to send the request again. */
function willRetry(reason: CompactionReason) {
  return reason === "overflow";
}

/** How Pi begins the error message of a compaction that failed, by what started it. */
const COMPACTION_FAILED = {
  manual: "Compaction failed",
  threshold: "Auto-compaction failed",
  overflow: "Context overflow recovery failed",
} satisfies Record<CompactionReason, string>;

/**
 * Pi's error for a request that overflows the context again after the compaction its overflow
 * started (`AgentSession._checkCompaction`).
 */
const OVERFLOW_AGAIN =
  "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.";

/** Pi's error for an answer cut off again below the output limit after that compaction. */
const TRUNCATED_AGAIN = "Truncated response recovery failed after one compact-and-retry attempt.";

/** `session_compact_failed` for a request that the compaction its overflow started did not help. */
function recoveryFailed(errorMessage: string): SessionCompactFailedEvent {
  return {
    type: "session_compact_failed",
    reason: "overflow",
    errorMessage,
    aborted: false,
    willRetry: false,
    fromExtension: false,
  };
}

/**
 * What a commit stored that `AttachedConversation.followCompactions` reads: entries, tasks,
 * submissions and changes of `pi.live`.
 */
type StoredChange =
  | Extract<CommitChange, { readonly type: "entry" | "task" | "submission" }>
  | LiveChange;

/** A task a commit stored. */
type StoredTask = Extract<StoredChange, { readonly type: "task" }>["value"];

/** A submission a commit stored. */
type StoredSubmission = Extract<StoredChange, { readonly type: "submission" }>["value"];

/** A change of a conversation's `pi.live`, at the definition version the Harness runs. */
type LiveChange = Extract<CommitChange, { readonly type: "document"; readonly kind: "change" }> & {
  readonly conversationId: ConversationId;
};

/** Whether `followCompactions` reads `change`: a `pi.live` change only in the shape this Harness writes. */
function isStored(change: CommitChange): change is StoredChange {
  switch (change.type) {
    case "entry":
    case "task":
    case "submission":
      return true;
    case "document":
      return (
        change.kind === "change" &&
        change.conversationId !== undefined &&
        change.record.kind === LiveDoc.definition.kind &&
        change.version === LiveDoc.definition.version
      );
    default:
      return false;
  }
}

/**
 * What the adapter's `beforeCompact` hook learned of a compaction that pi-durable's summary entry
 * has no place for, by its cut, see `CompactionNotes`.
 */
type CompactionNote = {
  /**
   * The context's estimated size when a compaction at this cut chose what to summarize, as Pi's;
   * the latest one's, should two run at the same cut.
   */
  tokensBefore: number;
  /** What `session_before_compact` handlers' compactions carried, by their summaries' hashes. */
  summaries: Record<string, Supplied>;
};

/** What a `session_before_compact` handler's compaction carried besides its summary. */
type Supplied = {
  tokensBefore: number;
  details?: JsonValue;
  /** Pi's `Usage`. */
  usage?: JsonValue;
};

/**
 * What the adapter's `beforeCompact` hook learned of each compaction, by its first kept entry, the
 * cut, which pi-durable places as the summary entry's `head`, and a handler's notes within it by
 * their summary's hash. pi-durable places a summary in an entry of its own, from another task when
 * the conversation is busy, so the cut and the summary are all that link the entry to its
 * compaction; compactions at the same cut, which pi-durable lets overlap and places each, keep
 * their own notes. The hook writes them before it returns, so every read that sees the entry finds
 * them, a fork's and one after a restart too. An entry whose summary has no notes is pi-durable's
 * own. Summaries of the same text at the same cut share notes, the latest handler's: so does
 * pi-durable's own summary, or another hook's, whose text is a handler's at that cut, as after a
 * restart that ran no handler, or in a fork that copied the record (`fork: "current"`). A fork's
 * copies of records for cuts it does not share are never looked up.
 */
const CompactionNotes = defineDoc<{ notes: Record<string, CompactionNote> }>({
  kind: "pi-durable-extension-adapter.compaction-notes",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ notes: {} }),
  // It grows by a note for each compaction, so a complete value now and then bounds what a read
  // replays without rewriting every note at each one, as pi-durable's own `pi.codemode.store`.
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

/** The hash of a summary, by which a handler's notes find their summary entry. */
function summaryHash(summary: string) {
  return createHash("sha256").update(summary).digest("base64url");
}

/** When a compaction's summary was placed, as its summary message's time. */
function placedAt(record: EntryRecord) {
  return record.model?.[0]?.timestamp ?? 0;
}

/** The handler's notes in `note` of the summary `entry` placed, if a handler supplied it. */
function suppliedFor(note: CompactionNote | undefined, entry: EntryRecord) {
  return note?.summaries[summaryHash(compactionSummary(entry))];
}

/**
 * What Pi's compaction entry has that only pi-durable's context tells: the context's estimated
 * size before the compaction, and its system message then.
 */
type Measured = {
  readonly tokensBefore: number;
  readonly systemMessage?: SystemMessage;
};

/** How many entries a search for the newest entry the session shows reads at a time. */
const NEWEST_PAGE = 16;

/**
 * One of the conversation's entries, other than a compaction summary (`compactionSessionEntry`), as
 * Pi's session entries: an extension's entry, a message it sent, or the conversation's messages,
 * one entry each, after `parentId`. pi-durable keeps no time on an entry, so an entry has its
 * first message's time, or else `now`.
 */
function sessionEntries(record: EntryRecord, parentId: string | null, now: string): SessionEntry[] {
  const id = `${record.id}`;
  const messages = record.model ?? [];
  const first = messages[0];
  if (record.kind.startsWith("piext.")) {
    const timestamp = first ? new Date(first.timestamp).toISOString() : now;
    const customType = record.kind.slice("piext.".length);
    // A message an extension sent carries what the model sees; `appendEntry`'s carries only data.
    if (first?.role !== "user")
      return [{ type: "custom", id, parentId, timestamp, customType, data: record.data }];
    const sent = Guard.IsObjectNotArray(record.data) ? record.data : {};
    return [
      {
        type: "custom_message",
        id,
        parentId,
        timestamp,
        customType,
        content: first.content,
        display: sent.display !== false,
        ...(sent.details !== undefined && { details: sent.details }),
      },
    ];
  }
  const entries: SessionEntry[] = [];
  for (const [index, message] of messages.entries()) {
    const messageId = index === 0 ? id : `${id}:${index}`;
    entries.push({
      type: "message",
      id: messageId,
      parentId: entries.at(-1)?.id ?? parentId,
      timestamp: new Date(message.timestamp).toISOString(),
      message,
    });
  }
  return entries;
}

/**
 * A compaction summary as Pi's compaction entry, after `parentId`: with what the adapter's hook
 * noted of its compaction (`CompactionNotes`), a handler's notes if they are of this summary, and
 * what the context `measured` before it.
 */
function compactionSessionEntry(
  record: TypedEntry<{ reason: CompactionReason }>,
  parentId: string | null,
  note: CompactionNote | undefined,
  measured: Measured | undefined,
): SessionCompactionEntry {
  const placed = placedAt(record);
  const supplied = suppliedFor(note, record);
  return {
    type: "compaction",
    id: `${record.id}`,
    parentId,
    timestamp: new Date(placed).toISOString(),
    summary: compactionSummary(record),
    firstKeptEntryId: `${record.head ?? record.id}`,
    tokensBefore: supplied?.tokensBefore ?? note?.tokensBefore ?? measured?.tokensBefore ?? 0,
    fromHook: supplied !== undefined,
    ...(supplied?.details !== undefined && { details: supplied.details }),
    ...(supplied?.usage !== undefined && {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- stored as JSON from Pi's `Usage` (`toJson` in the worker), which pi-ai has no schema for
      usage: supplied.usage as unknown as Usage,
    }),
    // At the summary's time, as Pi stamps it.
    ...(measured?.systemMessage && {
      systemMessage: { ...measured.systemMessage, timestamp: placed },
    }),
  };
}

/** A message `before_agent_start` returned, as the request carries it. */
function sentMessage(content: RunStart["sent"][number]): Message {
  return {
    role: "user",
    content: typeof content === "string" ? content : [...content],
    timestamp: Date.now(),
  };
}

/**
 * Entries read a page at a time, by default of the size pi-durable's README pages hook reads by,
 * for a read that stops early a smaller one.
 */
async function* paged(
  read: (limit: number, cursor: Cursor | undefined) => Promise<Page<EntryRecord, Cursor>>,
  size = 1000,
): AsyncGenerator<EntryRecord> {
  let cursor: Cursor | undefined;
  do {
    const page = await read(size, cursor);
    yield* page.items;
    cursor = page.next;
  } while (cursor !== undefined);
}

/** Every entry in `range` of the hook's conversation, oldest first. */
async function records(
  api: HookApi,
  range: Pick<EntryQuery, "minEntryId" | "maxEntryId">,
  context: Context,
): Promise<EntryRecord[]> {
  return Array.fromAsync(
    paged((limit, cursor) => api.entries({ ...range, order: "ascending" }, limit, cursor, context)),
  );
}

/** Whether a prompt was written after the newest of `inputs`: the run is being continued. */
async function userEntryAfter(inputs: readonly EntryId[], api: HookApi, context: Context) {
  const newest = inputs.reduce((a, b) => (b > a ? b : a));
  // Newest first: a continuation's prompt is near the end, after the run's rounds.
  for await (const entry of paged((limit, cursor) =>
    api.entries({ minEntryId: newest }, limit, cursor, context),
  )) {
    if (entry.id !== newest && entry.kind === UserEntry.kind) return true;
  }
  return false;
}

function newestUserContent(messages: readonly Message[]): UserContent {
  return messages.findLast((each) => each.role === "user")?.content ?? "";
}

type UserContent = Extract<Message, { role: "user" }>["content"];

/** A prompt's content as Pi's `before_agent_start` gets it: its text, and its images apart. */
function userTrigger(content: UserContent): AgentStartTrigger {
  if (typeof content === "string") return { messageType: "user", prompt: content };
  return {
    messageType: "user",
    prompt: contentText(content),
    images: content.filter((part): part is ImageContent => part.type === "image"),
  };
}

/** `messages` with `sections` added to the leading system message's, for this request only. */
function withSections(messages: Message[], sections: Readonly<Record<string, string>>): Message[] {
  if (Object.keys(sections).length === 0) return messages;
  const [first, ...rest] = messages;
  if (first?.role === "system") {
    return [{ ...first, sections: { ...first.sections, ...sections } }, ...rest];
  }
  const system: Message = { role: "system", content: "", sections: { ...sections }, timestamp: 0 };
  return [system, ...messages];
}
