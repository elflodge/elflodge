import { constants } from "node:buffer";
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
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  Models,
} from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai/utils/text";
import type {
  ExecResult,
  InputEvent,
  InputEventResult,
  SessionEntry,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  AgentDoc,
  type AgentState,
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
  ProviderDoc,
  type Registry,
  section,
  type RunSummary,
  ToolTask,
  UserEntry,
  type Conversation,
  type ToolExecutionResult,
  type ToolHookCall,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createBirpc, type BirpcReturn } from "birpc";
import ensureError from "ensure-error";
import { SyncMessagePort } from "sync-message-port";
import Type, { type Static } from "typebox";
import { Guard } from "typebox/guard";
import { Value } from "typebox/value";

import type { PreparedExtensions } from "./prepare.ts";
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
  Reads,
  Registrations,
  ToolDescriptor,
  ToolResult,
  WorkerData,
  WorkerFunctions,
} from "./protocol.ts";

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
   * goes on. Default: written to standard error, as Pi's print mode writes it.
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
   * value that no extension registered, source `flags`, or of the wrong type is reported here too.
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
  readonly worker: Worker;
  readonly rpc: BirpcReturn<WorkerFunctions, HostFunctions>;
  readonly conversations: Map<string, AttachedConversation>;
  idle: ReturnType<typeof setTimeout> | undefined;
  /** Keeps the process alive, or lets it exit, for the worker and its channels. */
  hold(held: boolean): void;
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
          if (this.#closed) void each.close();
          else this.#orphans.add(each);
        }
        return { id: each.conversationId, reopened };
      }),
    );
    const exit: WorkerExit = {
      reopened: results.filter((each) => each.reopened).map((each) => each.id),
      lost: results.filter((each) => !each.reopened).map((each) => each.id),
    };
    if (this.#options.onWorkerExit) this.#options.onWorkerExit(error, exit);
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
    const functions: HostFunctions = {
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
        if (!found) return;
        if (this.#options.onError) this.#options.onError(error, found.conversationId);
        else console.error(`Extension error (${error.source}): ${error.message}`);
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
      eventNames: ["cancelTool"],
    });
    const reads = new SyncMessagePort(journal.port1);
    const reply = (value: ReadReply) => {
      try {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker port, not a window
        reads.postMessage(value);
      } catch (error) {
        // A value, or an error's `cause`, that cannot be cloned: the worker waits for an answer all
        // the same, so it gets the message alone, which can.
        const message = ensureError("error" in value ? value.error : error).message;
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker port, not a window
        reads.postMessage({ error: new Error(message) } satisfies ReadReply);
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
        reply({ error: new Error(`No conversation ${message.key} on this worker`) });
        return;
      }
      found.read(message.method, message.args).then(
        (value) => reply({ value }),
        (error: unknown) => reply({ error: ensureError(error) }),
      );
    });
    const hosted: HostedWorker = {
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
      for (const each of hosting) each.lost();
      if (this.#closed) return;
      // A report the host cannot deliver, such as an `onWorkerExit` that throws, must not end the
      // process, which runs every other conversation.
      this.#recover(error, hosting, loading).catch((failed: unknown) => {
        console.error(ensureError(failed));
      });
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
  // A conversation gets its provider session ID when it is created; one from before that gets
  // it at its first request, so it uses its own ID until then.
  const sessionId = provider?.sessionId ?? `${conversation.id}`;
  const attached = new AttachedConversation(sessionId, options, installation, workers);
  installation.add(attached);
  try {
    await selectExtension(options, installation.conversations(), context);
    const opened = await attached.open(context);
    return {
      errors: opened.errors,
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
  const selection = async (each: Conversation) =>
    (await harness.snapshot(AgentDoc, each.id, context))?.extensions;
  // A conversation's extension one selects without naming it comes from the default selection: the
  // conversation's own, which `Installation.add` installed for this, or another attached
  // conversation's, as when an app reopens its Harness without the setting. One that selects
  // exactly the names it stores shows nothing of the default, which another attached conversation
  // that edits it shows, as they share it.
  let shows = conversation;
  let stored = await selection(conversation);
  for (const each of attached) {
    if (!Array.isArray(stored)) break;
    if (each === conversation) continue;
    shows = each;
    stored = await selection(each);
  }
  const named = new Set(Array.isArray(stored) ? stored : stored?.add);
  const { extensions } = await shows.agent(context);
  if (extensions.some(({ name }) => name.startsWith(EXTENSION_PREFIX) && !named.has(name))) {
    throw new Error(
      "Set the Harness's settings.extensions to the extensions conversations select by default: " +
        "without it, every conversation selects every attached conversation's extensions",
    );
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

  constructor(workers: Workers, harness: Harness, registry: Registry, emptied: () => void) {
    this.workers = workers;
    this.harness = harness;
    this.#registry = registry;
    this.#emptied = emptied;
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
  }

  /**
   * The conversation `owner`, when it is the one `api` runs in. A conversation created from it, such
   * as a subagent or a fork, inherits its selection and so its extension, and is not attached: its
   * calls to the tools fail and the hooks do nothing for it.
   */
  #for(owner: ConversationId, api: { conversationId: ConversationId }) {
    return api.conversationId === owner ? this.#conversations.get(owner) : undefined;
  }

  /** Hooks for the Pi events the conversation's extensions listen to, and only those. */
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
      ...(has(...REQUEST_EVENTS) && {
        beforeRequest: async (request, api, context) =>
          this.#for(owner, api)?.beforeRequest(request, api, context),
      }),
      ...(has("before_provider_request") && {
        beforeProviderRequest: async (request, api, context) =>
          this.#for(owner, api)?.beforeProviderRequest(request, context),
      }),
      ...(has("message_end", "turn_end") && {
        afterResponse: async (message, api, context) =>
          this.#for(owner, api)?.afterResponse(message, api, context),
      }),
      ...(has("turn_end") && {
        afterTools: async (assistant, _results, api, context) =>
          this.#for(owner, api)?.turnEnd(assistant, api, context),
      }),
      ...(has("agent_end") && {
        afterRun: async (run, api, context) => {
          await this.#for(owner, api)?.agentEnd(run, api, context);
          return undefined;
        },
      }),
    };
    if (Object.keys(generation).length > 0) hooks.push(hook(GenerationTask, generation));
    if (has("session_before_compact")) {
      hooks.push(
        hook(CompactionTask, {
          beforeCompact: async (compaction, api, context) =>
            this.#for(owner, api)?.beforeCompact(compaction, context),
        }),
      );
    }
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
  /** What the extensions registered, as last read. */
  registrations: Registrations = { tools: [], events: [] };
  /** The extensions' writes to the conversation so far, which a read waits for. */
  #writes: Promise<unknown> = Promise.resolve();
  /** The model tools being set, which the next selection waits for. */
  #activation: Promise<void> = Promise.resolve();
  /** Commands `pi.exec` runs, by the ID the worker gave them, to cancel when their signal aborts. */
  readonly #execs = new Map<number, AbortController>();

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
    // Opened again, the extensions keep what they registered before, a `tool_call` gate included,
    // until they are all back: one that loaded before and fails now fails the reopen.
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
      this.lost();
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
    if (round || !this.#listens("turn_end")) return;
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

  /** `agent_end` with the run's messages; pi-durable has no hook for a run that fails or aborts. */
  async agentEnd(run: RunSummary, api: HookApi, context: Context) {
    await awaitWithContext(this.#ready, context);
    if (!this.#running) return;
    const range = await records(api, { minEntryId: run.first, maxEntryId: run.last }, context);
    const messages = range.flatMap((record) => record.model ?? []);
    await this.#rpc.emit(this.#route, { type: "agent_end", messages });
  }

  /** `session_before_compact`: a cancel declines the compaction, a summary replaces pi-durable's. */
  async beforeCompact(
    compaction: {
      readonly reason: CompactionReason;
      readonly messages: readonly Message[];
      readonly firstKept: EntryId;
      readonly instructions?: string;
    },
    context: Context,
  ) {
    await awaitWithContext(this.#ready, context);
    if (!this.#running) return undefined;
    const decision = await this.#rpc.beforeCompact(this.#route, {
      reason: compaction.reason,
      instructions: compaction.instructions,
      firstKept: `${compaction.firstKept}`,
      messages: compaction.messages.filter((message) => message.role !== "system"),
      entries: await this.#entries(),
    });
    if (!decision) return undefined;
    return "cancel" in decision ? { decline: true as const } : { summary: decision.summary };
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
    const settled = started.catch(() => {});
    if (action.type !== "abort" && action.type !== "compact") {
      this.#writes = Promise.all([this.#writes, settled]);
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

  /** Answers a worker's synchronous read, after the writes sent before it. */
  async read(method: keyof Reads, args: readonly unknown[]): Promise<unknown> {
    await this.#writes;
    const { conversation, harness } = this.#options;
    const context = BACKGROUND_CONTEXT;
    switch (method) {
      case "flush":
        return null;
      case "getBranch": {
        const entries = await this.#entries();
        const end = typeof args[0] === "string" ? entries.findIndex((e) => e.id === args[0]) : -1;
        return end === -1 ? entries : entries.slice(0, end + 1);
      }
      case "getEntries":
        return this.#entries();
      case "getEntry":
        return (await this.#entries()).find((entry) => entry.id === args[0]);
      case "getLeafId":
        return (await this.#entries()).at(-1)?.id ?? null;
      case "getModel": {
        const { model } = await conversation.agent(context);
        return model && this.models.getModel(model.provider, model.modelId);
      }
      case "getThinkingLevel":
        return (await conversation.agent(context)).thinkingLevel;
      case "isIdle":
        return (await harness.snapshot(LiveDoc, conversation.id, context))?.run === undefined;
      case "getActiveTools":
        return (await conversation.agent(context)).tools.map((tool) => tool.name);
      case "getAllTools":
        return (await conversation.agent(context)).tools.map((tool): ToolInfo => ({
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
        }));
      case "getModels": {
        const available = await this.models.getAvailable().then(
          (list) => list.map((each) => `${each.provider}/${each.id}`),
          () => [],
        );
        return { models: [...this.models.getModels()], available };
      }
    }
    const unknown: never = method;
    throw new Error(`Unknown read ${String(unknown)}`);
  }

  /**
   * The conversation's entries as Pi's session entries: extensions' entries, the messages they
   * sent, and the conversation's messages. pi-durable keeps no time on an entry, so an entry has
   * its message's time, or else the time of the read.
   */
  async #entries(): Promise<SessionEntry[]> {
    const found = await Array.fromAsync(
      paged((limit, cursor) =>
        this.#options.conversation.entries(
          { order: "ascending" },
          limit,
          cursor,
          BACKGROUND_CONTEXT,
        ),
      ),
    );
    const entries: SessionEntry[] = [];
    let parentId: string | null = null;
    const now = new Date().toISOString();
    for (const record of found) {
      const id = `${record.id}`;
      const messages = record.model ?? [];
      const first = messages[0];
      const timestamp = first ? new Date(first.timestamp).toISOString() : now;
      if (record.kind.startsWith("piext.")) {
        const customType = record.kind.slice("piext.".length);
        // A message an extension sent carries what the model sees; `appendEntry`'s carries only data.
        if (first?.role === "user") {
          const sent = Guard.IsObjectNotArray(record.data) ? record.data : {};
          entries.push({
            type: "custom_message",
            id,
            parentId,
            timestamp,
            customType,
            content: first.content,
            display: sent.display !== false,
            ...(sent.details !== undefined && { details: sent.details }),
          });
        } else {
          entries.push({ type: "custom", id, parentId, timestamp, customType, data: record.data });
        }
        parentId = id;
        continue;
      }
      for (const [index, message] of messages.entries()) {
        const messageId = index === 0 ? id : `${id}:${index}`;
        entries.push({
          type: "message",
          id: messageId,
          parentId,
          timestamp: new Date(message.timestamp).toISOString(),
          message,
        });
        parentId = messageId;
      }
    }
    return entries;
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
   * nothing, and a `tool_call` gate blocks.
   */
  lost() {
    this.#hosted = undefined;
    // Their worker can no longer read the result, and a new one numbers its commands afresh.
    for (const each of this.#execs.values()) each.abort();
    this.#execs.clear();
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close() {
    // One time limit for the loading under way and the shutdown handlers.
    const limited = withAbortSignal(AbortSignal.timeout(STUCK_AFTER_MS), BACKGROUND_CONTEXT);
    await awaitWithContext(this.#ready, limited).catch(() => {});
    this.#installation.remove(this);
    const hosted = this.#hosted;
    if (hosted) {
      // What `session_shutdown` handlers write is kept, as the worker waits for it before it
      // answers; what extensions do after it, or after the time limit, is dropped.
      await awaitWithContext(hosted.rpc.close(this.#route), limited).catch(() => {});
    }
    this.#closed = true;
    this.#release?.();
  }
}

/**
 * How long opening a conversation's extensions, or closing them, may take before it is given up
 * on. Loading and the session handlers take well under a second (about 180 ms on a new worker with
 * `pi-web-access` and `pi-web-search`), so only a handler that never finishes reaches it. Without a
 * limit, such a handler would hold up `attach`, the conversation's hooks after a reopen, or the end
 * of its work and its place on the worker, until the caller's own deadline, which is sized for a
 * whole job. Pi has no limit, as a person at the terminal ends what hangs; nobody does for an
 * unattended host. It is wall time: a worker that another conversation's synchronous work keeps
 * busy that long counts too, as it holds up every conversation on it already.
 */
const STUCK_AFTER_MS = 10_000;

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

/** A value as JSON, as pi-durable stores it: what does not survive JSON is dropped. */
function toJson(value: unknown): JsonValue | undefined {
  const text = JSON.stringify(value);
  return text === undefined ? undefined : JSON.parse(text);
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

/** A message `before_agent_start` returned, as the request carries it. */
function sentMessage(content: RunStart["sent"][number]): Message {
  return {
    role: "user",
    content: typeof content === "string" ? content : [...content],
    timestamp: Date.now(),
  };
}

/** Entries read a page at a time, of the size pi-durable's README pages hook reads by. */
async function* paged(
  read: (limit: number, cursor: Cursor | undefined) => Promise<Page<EntryRecord, Cursor>>,
): AsyncGenerator<EntryRecord> {
  let cursor: Cursor | undefined;
  do {
    const page = await read(1000, cursor);
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
