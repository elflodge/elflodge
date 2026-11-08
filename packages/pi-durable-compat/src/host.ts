import path from "node:path";
import { fileURLToPath } from "node:url";
import { MessageChannel, Worker } from "node:worker_threads";

import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Api, ImageContent, Message, Model, Models } from "@earendil-works/pi-ai";
import type { InputEventResult } from "@earendil-works/pi-coding-agent";
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
  ProviderDoc,
  type Registry,
  ToolTask,
  type Conversation,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createBirpc, type BirpcReturn } from "birpc";
import { SyncMessagePort } from "sync-message-port";

import type { PreparedExtensions } from "./prepare.ts";
import type {
  Action,
  ConversationState,
  HistoryRead,
  HistoryReply,
  HostFunctions,
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
  /** The most worker threads extensions run in; each holds the extensions' modules once. Default 2. */
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
   * The models the Harness was opened with, for what extensions do outside a tool call or hook,
   * which use the call's own. `Harness` does not expose its own.
   */
  readonly models: Models;
  /** The environment commands run in outside a tool call or hook, if any. */
  readonly env?: ExecutionEnv;
  /** The directory extensions see as `ctx.cwd`. */
  readonly cwd: string;
}

/** One conversation's extensions. */
export interface AttachedExtensions {
  /** Extensions that failed to load for this conversation, with the reason; the rest run. */
  readonly errors: readonly { readonly source: string; readonly error: string }[];
  /**
   * Runs the extensions' `input` handlers on input before it is submitted, as Pi does for a
   * prompt: the result says to submit it as it is, transformed, or not at all.
   */
  input(text: string, images: readonly ImageContent[] | undefined, context: Context): Promise<InputEventResult>;
  /**
   * Ends the extensions' session: `session_shutdown` runs, and what they do later, such as a
   * background message, is dropped. Call it when the conversation's work is decided.
   */
  close(): Promise<void>;
}

export interface ExtensionHost {
  /**
   * Starts the extensions for `conversation` on a worker and installs, in `registry`, a pi-durable
   * extension with their tools and only the hooks some extension listens to.
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
  return {
    attach: (attach, context) => attachConversation(workers, attach, context),
    close: () => workers.close(),
  };
}

const workerModule = fileURLToPath(
  new URL(`./worker${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);

interface HostedWorker {
  readonly worker: Worker;
  readonly rpc: BirpcReturn<WorkerFunctions, HostFunctions>;
  readonly sessions: Map<string, Session>;
  idle: ReturnType<typeof setTimeout> | undefined;
}

/**
 * The workers, each with its conversations. A conversation goes to an idle worker, else to a new
 * one while fewer than `maxWorkers` run, else to the least busy, and stays there; a worker exits
 * once it has had no conversation for `idleTimeout`. Effect's `Pool` caps the borrowers of an item
 * and makes the rest wait, while a conversation holds its worker for as long as its job runs.
 */
class Workers {
  readonly #options: ExtensionHostOptions;
  readonly #workers = new Set<HostedWorker>();

  constructor(options: ExtensionHostOptions) {
    this.#options = options;
  }

  acquire(key: string, session: Session): HostedWorker {
    const max = this.#options.maxWorkers ?? 2;
    let chosen: HostedWorker | undefined;
    for (const each of this.#workers) {
      if (!chosen || each.sessions.size < chosen.sessions.size) chosen = each;
    }
    if (!chosen || (chosen.sessions.size > 0 && this.#workers.size < max)) chosen = this.#start();
    clearTimeout(chosen.idle);
    chosen.idle = undefined;
    chosen.sessions.set(key, session);
    return chosen;
  }

  release(hosted: HostedWorker, key: string) {
    hosted.sessions.delete(key);
    if (hosted.sessions.size > 0) return;
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
      await Promise.allSettled([...hosted.sessions.values()].map((session) => session.close()));
      await hosted.worker.terminate();
    }
  }

  #start(): HostedWorker {
    const history = SyncMessagePort.createChannel();
    const rpc = new MessageChannel();
    const workerData: WorkerData = {
      runtime: this.#options.prepared.runtime,
      extensions: this.#options.prepared.extensions,
      history: history.port2,
      rpc: rpc.port2,
    };
    const worker = new Worker(workerModule, { workerData, transferList: [history.port2, rpc.port2] });
    worker.unref();
    const sessions = new Map<string, Session>();
    const session = (key: string) => {
      const found = sessions.get(key);
      if (!found) throw new Error(`No conversation ${key} on this worker`);
      return found;
    };
    const functions: HostFunctions = {
      act: (key, action) => sessions.get(key)?.act(action),
      setModel: (key, model) => session(key).setModel(model),
      exec: (key, command, args, options) => session(key).exec(command, args, options),
      getApiKeyAndHeaders: (key, model) => session(key).getApiKeyAndHeaders(model),
      getProviderAuth: (key, provider) => session(key).models.getAuth(provider),
      getApiKeyForProvider: async (key, provider) =>
        (await session(key).models.getAuth(provider))?.auth.apiKey,
      toolUpdate: () => {},
      changed: (key) => sessions.get(key)?.changed(),
    };
    const port = rpc.port1;
    port.unref();
    const client = createBirpc<WorkerFunctions, HostFunctions>(functions, {
      post: (message) => port.postMessage(message),
      on: (handler) => port.on("message", handler),
      timeout: -1,
    });
    const reads = new SyncMessagePort(history.port1);
    reads.on("message", (request: HistoryRead) => {
      const found = sessions.get(request.key);
      const reply = (value: HistoryReply) => reads.postMessage(value);
      if (!found) {
        reply({ id: request.id, error: `No conversation ${request.key} on this worker` });
        return;
      }
      found.read(request).then(
        (value) => reply({ id: request.id, value }),
        (error: unknown) => reply({ id: request.id, error: error instanceof Error ? error.message : String(error) }),
      );
    });
    const hosted: HostedWorker = { worker, rpc: client, sessions, idle: undefined };
    worker.on("exit", () => {
      this.#workers.delete(hosted);
      client.$close(new Error("The extension worker exited"));
      for (const each of sessions.values()) each.lost();
    });
    this.#workers.add(hosted);
    return hosted;
  }
}

async function attachConversation(
  workers: Workers,
  options: AttachOptions,
  context: Context,
): Promise<AttachedExtensions> {
  const { harness, conversation } = options;
  const provider = await harness.snapshot(ProviderDoc, conversation.id, context);
  // A conversation gets its provider session ID when it is created; one from before that gets
  // it at its first request, so it is keyed by its own ID until then.
  const key = provider?.sessionId ?? `${conversation.id}`;
  const session = new Session(key, options);
  const hosted = workers.acquire(key, session);
  session.bind(hosted, () => workers.release(hosted, key));
  const opened = await hosted.rpc.open(key, { cwd: options.cwd, state: await session.state(context) });
  session.install(opened);
  await hosted.rpc.emit(key, { type: "session_start", reason: "startup" });
  return {
    errors: opened.errors,
    input: (text, images, inputContext) => session.input(text, images, inputContext),
    close: () => session.close(),
  };
}

/** One attached conversation: its worker, its pi-durable extension, and the actions it carries out. */
class Session {
  readonly key: string;
  readonly models: Models;
  readonly #options: AttachOptions;
  #hosted: HostedWorker | undefined;
  #release: (() => void) | undefined;
  #closed = false;
  #installed: ReturnType<typeof defineExtension> | undefined;

  constructor(key: string, options: AttachOptions) {
    this.key = key;
    this.models = options.models;
    this.#options = options;
  }

  get #rpc() {
    if (!this.#hosted || this.#closed) throw new Error("The conversation's extensions are closed");
    return this.#hosted.rpc;
  }

  bind(hosted: HostedWorker, release: () => void) {
    this.#hosted = hosted;
    this.#release = release;
  }

  get name() {
    return `pi-durable-compat:${this.key}`;
  }

  /** Installs, or replaces, the conversation's pi-durable extension for `registrations`. */
  install(registrations: Registrations) {
    const events = new Set(registrations.events);
    const conversationId = this.#options.conversation.id;
    const mine = (api: { conversationId: ConversationId }) => api.conversationId === conversationId && !this.#closed;
    const hooks: HookRegistration[] = [];
    if (events.has("tool_call") || events.has("tool_result")) {
      hooks.push(
        hook(ToolTask, {
          ...(events.has("tool_call") && {
            beforeTool: async (call, api) => {
              if (!mine(api)) return undefined;
              const { result, input } = await this.#rpc.toolCall(this.key, {
                type: "tool_call",
                toolCallId: call.id,
                toolName: call.name,
                input: structuredClone(call.arguments),
              });
              if (result?.block) return { block: result.reason ?? "Blocked by an extension" };
              const changed = toJson(input);
              if (JSON.stringify(changed) === JSON.stringify(call.arguments)) return undefined;
              return isJsonObjectValue(changed) ? { arguments: changed } : undefined;
            },
          }),
          ...(events.has("tool_result") && {
            afterTool: async (call, result, api) => {
              if (!mine(api)) return undefined;
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
                ...(changed.details !== undefined && { details: toJson(changed.details) }),
                ...(changed.isError !== undefined && { isError: changed.isError }),
              };
            },
          }),
        }),
      );
    }
    if (events.has("context") || events.has("before_provider_request")) {
      hooks.push(
        hook(GenerationTask, {
          ...(events.has("context") && {
            beforeRequest: async (request, api) => {
              if (!mine(api)) return undefined;
              const messages = await this.#rpc.context(this.key, [...request.messages]);
              // Pi's own message kinds, such as a shell command's output, have no meaning here.
              return { messages: messages.filter(isMessage) };
            },
          }),
          ...(events.has("before_provider_request") && {
            beforeProviderRequest: async (request, api) => {
              if (!mine(api)) return undefined;
              return { payload: await this.#rpc.providerRequest(this.key, request.payload) };
            },
          }),
        }),
      );
    }
    this.#installed = defineExtension({
      name: this.name,
      tools: registrations.tools.flatMap((tool) => this.#tool(tool)),
      hooks,
    });
    this.#options.registry.install(this.#installed);
  }

  #tool(descriptor: ToolDescriptor): ToolRegistration[] {
    if (descriptor.exposure === "hidden") return [];
    const conversationId = this.#options.conversation.id;
    return [
      defineTool({
        name: descriptor.name,
        description: descriptor.description,
        parameters: descriptor.parameters,
        // A Pi tool may have run part of its work when a crash stops it.
        replay: "unsafe",
        ...(descriptor.executionMode && { executionMode: descriptor.executionMode }),
        ...(descriptor.exposure === "model-only" && { callers: ["model"] as const }),
        ...(descriptor.prepareArguments && {
          prepareArguments: (args: unknown) => repairArguments(args, descriptor.parameters),
        }),
        execute: async (args, api, context) => {
          if (api.conversationId !== conversationId) throw new Error("Not this conversation's tool");
          const abort = () => void this.#hosted?.rpc.cancelTool(api.callId);
          context.abortSignal?.addEventListener("abort", abort, { once: true });
          try {
            const result = await this.#rpc.executeTool(this.key, api.callId, descriptor.name, args);
            return toolOutput(result);
          } finally {
            context.abortSignal?.removeEventListener("abort", abort);
          }
        },
      }),
    ];
  }

  /** Re-reads the extensions' registrations after a change and reinstalls the conversation's extension. */
  changed() {
    if (this.#closed || !this.#hosted) return;
    void this.#hosted.rpc.registrations(this.key).then(
      (registrations) => this.install(registrations),
      () => {},
    );
  }

  async state(context: Context): Promise<ConversationState> {
    const agent = await this.#options.conversation.agent(context);
    const model = agent.model && this.models.getModel(agent.model.provider, agent.model.modelId);
    const models = this.models.getModels();
    const available = await this.models.getAvailable().then(
      (list) => list.map((each) => `${each.provider}/${each.id}`),
      () => [],
    );
    return {
      model,
      thinkingLevel: agent.thinkingLevel,
      activeTools: agent.tools.map((tool) => tool.name),
      allTools: agent.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        exposure: "direct" as const,
        sourceInfo: { path: "<pi-durable>", source: "pi-durable", scope: "temporary", origin: "top-level" },
      })),
      sessionName: undefined,
      idle: true,
      contextUsage: undefined,
      systemPrompt: "",
      models: [...models],
      available,
    };
  }

  act(action: Action) {
    if (this.#closed) return;
    const { conversation } = this.#options;
    const context = BACKGROUND_CONTEXT;
    const done = (promise: Promise<unknown>) => void promise.catch(() => {});
    switch (action.type) {
      case "sendMessage": {
        const [message, options] = action.args;
        const kind = `piext.${message.customType}`;
        const content = typeof message.content === "string" ? message.content : [...message.content];
        if (options?.triggerTurn) {
          done(
            conversation.submit(
              {
                type: "input",
                content,
                whenBusy: options.deliverAs === "steer" ? "steer" : "followUp",
                entry: { kind, ...(message.details !== undefined && { data: toJson(message.details) }) },
              },
              context,
            ),
          );
        } else {
          done(
            conversation.submit(
              {
                type: "write",
                entry: {
                  kind,
                  model: [{ role: "user", content, timestamp: Date.now() }],
                  ...(message.details !== undefined && { data: toJson(message.details) }),
                },
              },
              context,
            ),
          );
        }
        return;
      }
      case "sendUserMessage": {
        const [content, options] = action.args;
        done(
          conversation.submit(
            {
              type: "input",
              content: typeof content === "string" ? content : [...content],
              whenBusy: options?.deliverAs === "steer" ? "steer" : "followUp",
            },
            context,
          ),
        );
        return;
      }
      case "appendEntry":
        done(
          conversation.submit(
            { type: "write", entry: { kind: `piext.${action.customType}`, data: toJson(action.data) } },
            context,
          ),
        );
        return;
      case "compact":
        done(conversation.compact(action.instructions, context));
        return;
      case "abort":
        done(conversation.abort(context));
        return;
      default:
        // Session names, labels, active tools, thinking levels and shutdown are not carried out yet.
        return;
    }
  }

  async setModel(_model: Model<Api>): Promise<boolean> {
    return false;
  }

  async exec(command: string, args: string[], options: { cwd?: string; timeout?: number } | undefined) {
    const env = this.#options.env;
    if (!env) throw new Error("No environment to run commands in");
    let stdout = "";
    let stderr = "";
    const result = await env.exec(
      [command, ...args],
      {
        ...(options?.cwd !== undefined && { cwd: options.cwd }),
        ...(options?.timeout !== undefined && { timeout: options.timeout }),
        onOutput: (text, _context, info) => {
          if (info.stream === "stderr") stderr += text;
          else stdout += text;
        },
      },
      BACKGROUND_CONTEXT,
    );
    if (!result.ok) {
      return { stdout, stderr: stderr || result.error.message, code: 1, killed: false, truncated: false };
    }
    return { stdout, stderr, code: result.value.exitCode, killed: false, truncated: false };
  }

  async getApiKeyAndHeaders(model: Model<Api>) {
    try {
      const resolution = await this.models.getAuth(model);
      if (!resolution) return { ok: false as const, error: `No API key found for "${model.provider}"` };
      return {
        ok: true as const,
        ...(resolution.auth.apiKey !== undefined && { apiKey: resolution.auth.apiKey }),
        ...(resolution.auth.headers !== undefined && { headers: resolution.auth.headers }),
        ...(resolution.auth.baseUrl !== undefined && { baseUrl: resolution.auth.baseUrl }),
        ...(resolution.env !== undefined && { env: resolution.env }),
      };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Answers a read of `ctx.sessionManager` from the conversation's journal. */
  async read(request: HistoryRead): Promise<unknown> {
    const entries = await this.#entries();
    switch (request.method) {
      case "getBranch":
      case "getEntries":
        return entries;
      case "getLeafId":
        return entries.at(-1)?.id ?? null;
      case "getEntry":
        return entries.find((entry) => entry.id === request.args[0]);
    }
  }

  /** The conversation's entries as Pi's session entries: messages, and extensions' own entries. */
  async #entries() {
    const records: EntryRecord[] = [];
    let cursor: Parameters<Conversation["entries"]>[2];
    do {
      const page = await this.#options.conversation.entries({ order: "ascending" }, 500, cursor, BACKGROUND_CONTEXT);
      records.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    const entries: { type: string; id: string; parentId: string | null; timestamp: string; [field: string]: unknown }[] = [];
    let parentId: string | null = null;
    for (const record of records) {
      const timestamp = new Date().toISOString();
      if (record.kind.startsWith("piext.")) {
        const id = `${record.id}`;
        entries.push({ type: "custom", id, parentId, timestamp, customType: record.kind.slice(6), data: record.data });
        parentId = id;
        continue;
      }
      for (const [index, message] of (record.model ?? []).entries()) {
        const id = index === 0 ? `${record.id}` : `${record.id}:${index}`;
        entries.push({ type: "message", id, parentId, timestamp, message });
        parentId = id;
      }
    }
    return entries;
  }

  async input(text: string, images: readonly ImageContent[] | undefined, context: Context) {
    void context;
    return this.#rpc.input(this.key, text, images && [...images], "rpc");
  }

  /** The worker exited: the conversation's extensions are gone, and its tools fail from now on. */
  lost() {
    this.#hosted = undefined;
  }

  async close() {
    if (this.#closed) return;
    const hosted = this.#hosted;
    this.#closed = true;
    if (hosted) await hosted.rpc.close(this.key).catch(() => {});
    if (this.#installed) this.#options.registry.uninstall(this.#installed);
    this.#release?.();
  }
}

/**
 * Pi runs a tool's `prepareArguments` before validating its arguments; pi-durable does too, but
 * synchronously on the host thread, where waiting for the worker would stall every job. For a tool
 * that has one, the host repairs what models commonly get wrong, an array or object sent as JSON
 * text, and the worker runs the tool's own before it executes.
 */
function repairArguments(args: unknown, schema: object): unknown {
  if (!isJsonObject(args) || !("properties" in schema) || !isJsonObject(schema.properties)) return args;
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
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessage(message: { role: string }): message is Message {
  return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A value as JSON, as pi-durable stores it: what does not survive JSON is dropped. */
function toJson(value: unknown): JsonValue {
  const text = JSON.stringify(value);
  return text === undefined ? null : JSON.parse(text);
}

function toolOutput(result: ToolResult) {
  return {
    output: result.content.filter(isContentPart),
    details: toJson(result.details),
    ...(result.isError !== undefined && { isError: result.isError }),
  };
}

function isContentPart(part: unknown): part is { type: "text"; text: string } | ImageContent {
  return isJsonObject(part) && (part.type === "text" || part.type === "image");
}

void withAbortSignal;
