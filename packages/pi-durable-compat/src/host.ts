import { constants } from "node:buffer";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { MessageChannel, Worker } from "node:worker_threads";

import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Api, ImageContent, Message, Model, Models } from "@earendil-works/pi-ai";
import type {
  ExecResult,
  InputEventResult,
  SessionEntry,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  defineExtension,
  defineTool,
  type ConversationId,
  type EntryRecord,
  GenerationTask,
  type Harness,
  hook,
  type HookRegistration,
  type JsonObject,
  LiveDoc,
  ProviderDoc,
  type Registry,
  ToolTask,
  type Conversation,
  type ToolExecutionResult,
  type ToolHookCall,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createBirpc, type BirpcReturn } from "birpc";
import { Equal } from "effect";
import ensureError from "ensure-error";
import { SyncMessagePort } from "sync-message-port";

import type { PreparedExtensions } from "./prepare.ts";
import type {
  Action,
  ExtensionError,
  HostFunctions,
  JournalMessage,
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
  /** How long a worker with no conversation stays before it exits, in milliseconds. Default 30 s. */
  readonly idleTimeout?: number;
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
}

/** One conversation's extensions. */
export interface AttachedExtensions {
  /** Extensions that failed to load for this conversation, with the reason; the rest run. */
  readonly errors: readonly ExtensionError[];
  /**
   * Runs the extensions' `input` handlers on input before it is submitted, as Pi does for a
   * prompt: the result says to submit it as it is, transformed, or not at all.
   */
  input(text: string, images?: readonly ImageContent[]): Promise<InputEventResult>;
  /**
   * Ends the extensions' session: `session_shutdown` runs, and what they do later, such as a
   * background message, is dropped. Call it when the conversation's work is decided.
   */
  close(): Promise<void>;
}

export interface ExtensionHost {
  /**
   * Starts the extensions for `conversation` on a worker. The first conversation attached through a
   * registry installs a pi-durable extension in it, `pi-durable-compat`, with the extensions' tools
   * and only the hooks some extension listens to, for every conversation attached through it.
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
  const workers = new Workers(options);
  const installations = new Map<Registry, Installation>();
  const installationFor = ({ harness, registry }: AttachOptions) => {
    let found = installations.get(registry);
    if (!found) {
      found = new Installation(harness, registry, () => installations.delete(registry));
      installations.set(registry, found);
    }
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

  constructor(options: ExtensionHostOptions) {
    this.#options = options;
  }

  acquire(key: string, conversation: AttachedConversation): HostedWorker {
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

  release(hosted: HostedWorker, key: string) {
    hosted.conversations.delete(key);
    if (hosted.conversations.size > 0) return;
    // An idle worker is no reason for the process to stay.
    hosted.hold(false);
    hosted.idle = setTimeout(() => {
      this.#workers.delete(hosted);
      void hosted.worker.terminate();
    }, this.#options.idleTimeout ?? 30_000);
    hosted.idle.unref();
  }

  async close() {
    const all = [...this.#workers];
    this.#workers.clear();
    for (const hosted of all) {
      clearTimeout(hosted.idle);
      await Promise.allSettled([...hosted.conversations.values()].map((each) => each.close()));
      await hosted.worker.terminate();
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
    };
    const port = rpc.port1;
    const client = createBirpc<WorkerFunctions, HostFunctions>(functions, {
      post: (message) => port.postMessage(message),
      on: (handler) => port.on("message", handler),
      timeout: -1,
    });
    const reads = new SyncMessagePort(journal.port1);
    const reply = (value: ReadReply) => {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker port, not a window
      reads.postMessage(value);
    };
    reads.on("message", (message: JournalMessage) => {
      const found = conversations.get(message.key);
      if (message.type === "act") {
        found?.act(message.action);
        return;
      }
      if (!found) {
        reply({ id: message.id, error: `No conversation ${message.key} on this worker` });
        return;
      }
      found.read(message.method, message.args).then(
        (value) => reply({ id: message.id, value }),
        (error: unknown) => reply({ id: message.id, error: ensureError(error).message }),
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
      failure = error;
    });
    worker.on("exit", () => {
      this.#workers.delete(hosted);
      client.$close(
        new Error(`The extension worker exited${failure ? `: ${failure.message}` : ""}`),
      );
      for (const each of conversations.values()) each.lost();
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
  // it at its first request, so it is keyed by its own ID until then.
  const key = provider?.sessionId ?? `${conversation.id}`;
  const attached = new AttachedConversation(key, options, installation);
  installation.add(attached);
  const hosted = workers.acquire(key, attached);
  attached.bind(hosted, () => workers.release(hosted, key));
  try {
    const opened = await hosted.rpc.open(key, options.cwd);
    attached.update(opened);
    // A conversation with entries is one a host opened again, as after a restart, which extensions
    // learn as Pi tells them about a session it opens again.
    const earlier = await conversation.entries({ order: "ascending" }, 1, undefined, context);
    const reason = earlier.items.length > 0 ? "resume" : "startup";
    await hosted.rpc.emit(key, { type: "session_start", reason });
    // Extensions often register tools in `session_start`; they are installed before the first request.
    attached.update(await hosted.rpc.registrations(key));
    return {
      errors: opened.errors,
      input: (text, images) => attached.input(text, images),
      close: () => attached.close(),
    };
  } catch (error) {
    await attached.close();
    throw error;
  }
}

/**
 * The pi-durable extension in one registry, `pi-durable-compat`, shared by the conversations
 * attached through it: its tools and hooks act for the attached conversation they run in. One
 * extension, rather than one per conversation, because pi-durable selects every installed extension
 * for every conversation by default and the same tool names would replace each other; hosts limit
 * it to some conversations with pi-durable's own selection.
 */
class Installation {
  readonly harness: Harness;
  readonly #registry: Registry;
  readonly #emptied: () => void;
  readonly #conversations = new Map<ConversationId, AttachedConversation>();
  #installed: ReturnType<typeof defineExtension> | undefined;
  #installedFor: unknown;

  constructor(harness: Harness, registry: Registry, emptied: () => void) {
    this.harness = harness;
    this.#registry = registry;
    this.#emptied = emptied;
  }

  add(conversation: AttachedConversation) {
    if (this.#conversations.has(conversation.id)) {
      throw new Error(`Conversation ${conversation.id} has extensions attached already`);
    }
    this.#conversations.set(conversation.id, conversation);
  }

  remove(conversation: AttachedConversation) {
    if (this.#conversations.get(conversation.id) !== conversation) return;
    this.#conversations.delete(conversation.id);
    if (this.#conversations.size > 0) {
      this.refresh();
      return;
    }
    if (this.#installed) this.#registry.uninstall(this.#installed);
    this.#installed = undefined;
    this.#emptied();
  }

  /**
   * Installs the extension again when the attached conversations' tools or events changed: every
   * tool any of them registered, by name, the first registration winning, and every event any of
   * them listens to. A conversation whose extensions did not register a tool fails its calls.
   */
  refresh() {
    const tools = new Map<string, ToolDescriptor>();
    const events = new Set<string>();
    for (const conversation of this.#conversations.values()) {
      for (const tool of conversation.registrations.tools) {
        if (!tools.has(tool.name)) tools.set(tool.name, tool);
      }
      for (const event of conversation.registrations.events) events.add(event);
    }
    const wanted = [[...tools.values()], [...events].toSorted()];
    if (Equal.equals(wanted, this.#installedFor)) return;
    this.#installedFor = wanted;
    this.#installed = defineExtension({
      name: "pi-durable-compat",
      tools: [...tools.values()].flatMap((tool) => this.#tool(tool)),
      hooks: this.#hooks(events),
    });
    this.#registry.install(this.#installed);
  }

  #for(api: { conversationId: ConversationId }) {
    return this.#conversations.get(api.conversationId);
  }

  #hooks(events: Set<string>): HookRegistration[] {
    const hooks: HookRegistration[] = [];
    if (events.has("tool_call") || events.has("tool_result")) {
      hooks.push(
        hook(ToolTask, {
          ...(events.has("tool_call") && {
            beforeTool: async (call, api) => this.#for(api)?.beforeTool(call),
          }),
          ...(events.has("tool_result") && {
            afterTool: async (call, result, api) => this.#for(api)?.afterTool(call, result),
          }),
        }),
      );
    }
    if (events.has("context") || events.has("before_provider_request")) {
      hooks.push(
        hook(GenerationTask, {
          ...(events.has("context") && {
            beforeRequest: async (request, api) => this.#for(api)?.beforeRequest(request),
          }),
          ...(events.has("before_provider_request") && {
            beforeProviderRequest: async (request, api) =>
              this.#for(api)?.beforeProviderRequest(request),
          }),
        }),
      );
    }
    return hooks;
  }

  #tool(descriptor: ToolDescriptor): ToolRegistration[] {
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
          const conversation = this.#for(api);
          if (!conversation) throw new Error("No Pi extensions are attached to this conversation");
          return conversation.executeTool(descriptor.name, args, api.callId, context);
        },
      }),
    ];
  }
}

/** One attached conversation: its extensions' instance on a worker, and the actions it carries out. */
class AttachedConversation {
  readonly key: string;
  readonly models: Models;
  readonly #options: AttachOptions;
  #hosted: HostedWorker | undefined;
  #release: (() => void) | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  readonly #installation: Installation;
  /** What the extensions registered, as last read. */
  registrations: Registrations = { tools: [], events: [] };
  /** The extensions' writes to the conversation so far, which a read waits for. */
  #writes: Promise<unknown> = Promise.resolve();
  /** Commands `pi.exec` runs, by the ID the worker gave them, to cancel when their signal aborts. */
  readonly #execs = new Map<number, AbortController>();

  constructor(key: string, options: AttachOptions, installation: Installation) {
    this.key = key;
    this.models = options.models;
    this.#options = options;
    this.#installation = installation;
  }

  get #rpc() {
    if (!this.#hosted || this.#closed) throw new Error("The conversation's extensions are closed");
    return this.#hosted.rpc;
  }

  bind(hosted: HostedWorker, release: () => void) {
    this.#hosted = hosted;
    this.#release = release;
  }

  get id() {
    return this.#options.conversation.id;
  }

  /** Takes the extensions' current registrations, and installs them in the registry. */
  update(registrations: Registrations) {
    if (this.#closed) return;
    this.registrations = registrations;
    this.#installation.refresh();
  }

  async beforeTool(call: ToolHookCall) {
    if (this.#closed) return undefined;
    const { result, input } = await this.#rpc.toolCall(this.key, {
      type: "tool_call",
      toolCallId: call.id,
      toolName: call.name,
      input: structuredClone(call.arguments),
    });
    if (result?.block) return { block: result.reason ?? "Blocked by an extension" };
    const changed = toJson(input);
    if (changed === undefined || Equal.equals(changed, call.arguments)) return undefined;
    return isJsonObjectValue(changed) ? { arguments: changed } : undefined;
  }

  async afterTool(call: ToolHookCall, result: ToolExecutionResult) {
    if (this.#closed) return undefined;
    const changed = await this.#rpc.toolResult(this.key, {
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

  async beforeRequest(request: { readonly messages: readonly Message[] }) {
    if (this.#closed) return undefined;
    const messages = await this.#rpc.context(this.key, [...request.messages]);
    // Pi's own message kinds, such as a shell command's output, have no meaning here.
    return { messages: messages.filter(isMessage) };
  }

  async beforeProviderRequest(request: { readonly payload: unknown }) {
    if (this.#closed) return undefined;
    return { payload: await this.#rpc.providerRequest(this.key, request.payload) };
  }

  async executeTool(name: string, args: unknown, callId: string, context: Context) {
    const abort = () => void this.#hosted?.rpc.cancelTool(callId);
    context.abortSignal?.addEventListener("abort", abort, { once: true });
    try {
      return toolOutput(await this.#rpc.executeTool(this.key, callId, name, args));
    } finally {
      context.abortSignal?.removeEventListener("abort", abort);
    }
  }

  /** Reads the extensions' registrations again after they changed, and installs them. */
  reloadRegistrations() {
    if (this.#closed || !this.#hosted) return;
    void this.#hosted.rpc.registrations(this.key).then(
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
    // A failure, such as a conversation that closed meanwhile, has no one to report to: Pi's
    // actions return nothing.
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
              whenBusy: options.deliverAs === "steer" ? "steer" : "followUp",
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
        const [content, options] = action.args;
        return conversation.submit(
          {
            type: "input",
            content: typeof content === "string" ? content : [...content],
            whenBusy: options?.deliverAs === "steer" ? "steer" : "followUp",
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
      default:
        // Session names, labels, active tools and shutdown have no counterpart here.
        return undefined;
    }
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
      this.#execs.delete(id);
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
    const records: EntryRecord[] = [];
    let cursor: Parameters<Conversation["entries"]>[2];
    do {
      const page = await this.#options.conversation.entries(
        { order: "ascending" },
        500,
        cursor,
        BACKGROUND_CONTEXT,
      );
      records.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    const entries: SessionEntry[] = [];
    let parentId: string | null = null;
    const now = new Date().toISOString();
    for (const record of records) {
      const id = `${record.id}`;
      const messages = record.model ?? [];
      const first = messages[0];
      const timestamp = first ? new Date(first.timestamp).toISOString() : now;
      if (record.kind.startsWith("piext.")) {
        const customType = record.kind.slice("piext.".length);
        // A message an extension sent carries what the model sees; `appendEntry`'s carries only data.
        if (first?.role === "user") {
          const sent = isJsonObject(record.data) ? record.data : {};
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

  async input(text: string, images: readonly ImageContent[] | undefined) {
    return this.#rpc.input(this.key, text, images && [...images], "rpc");
  }

  /** The worker exited: the conversation's extensions are gone, and its tools fail from now on. */
  lost() {
    this.#hosted = undefined;
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close() {
    this.#installation.remove(this);
    const hosted = this.#hosted;
    if (hosted) {
      // What `session_shutdown` handlers write is kept; what extensions do after it is dropped.
      await hosted.rpc.close(this.key).catch(() => {});
      await this.#writes;
    }
    this.#closed = true;
    this.#release?.();
  }
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
 * text, and the worker runs the tool's own before it executes.
 */
function repairArguments(args: unknown, schema: object): unknown {
  if (!isJsonObject(args) || !("properties" in schema) || !isJsonObject(schema.properties))
    return args;
  let repaired: Record<string, unknown> | undefined;
  for (const [name, property] of Object.entries(schema.properties)) {
    const value = args[name];
    if (typeof value !== "string" || !isJsonObject(property)) continue;
    const wanted = property.type;
    if (wanted !== "array" && wanted !== "object") continue;
    try {
      const parsed: unknown = JSON.parse(value);
      if (wanted === "array" ? Array.isArray(parsed) : isJsonObject(parsed)) {
        repaired ??= { ...args };
        repaired[name] = parsed;
      }
    } catch {
      // Left as it is, for validation to report.
    }
  }
  return repaired ?? args;
}

function isJsonObjectValue(value: JsonValue): value is JsonObject {
  return isJsonObject(value);
}

function isMessage(message: { role: string }): message is Message {
  return ["system", "user", "assistant", "toolResult"].includes(message.role);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function isContentPart(part: unknown): part is { type: "text"; text: string } | ImageContent {
  return isJsonObject(part) && (part.type === "text" || part.type === "image");
}
