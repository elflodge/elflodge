import type { MessagePort } from "node:worker_threads";

import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Message,
  Model,
  Provider,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import type {
  CompactionResult,
  ContextUsage,
  ExecOptions,
  ExecResult,
  ExtensionActions,
  ExtensionRunner,
  MessageEndEvent,
  ModelRegistry,
  ProviderConfig,
  SessionEntry,
  ToolInfo,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import ensureError from "ensure-error";
import { serializeError } from "serialize-error";
import Type, { type Static } from "typebox";

// What crosses between the host thread and an extension worker. Values only: functions stay in the
// worker behind names, and the host keeps the pi-durable APIs the worker's calls act on.

export type ThinkingLevel = ReturnType<ExtensionActions["getThinkingLevel"]>;

/** A tool an extension registered, as the host registers it with pi-durable. */
export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly parameters: object;
  readonly prepareArguments: boolean;
  readonly executionMode: "parallel" | "sequential" | undefined;
  readonly exposure: "direct" | "model-only" | "codemode" | "deferred" | "hidden" | undefined;
  readonly defaultActive: boolean | undefined;
  /** What Pi lists for the tool among its prompt's tools while it is active, on one line. */
  readonly promptSnippet: string | undefined;
  /** What Pi adds to its prompt's rules while the tool is active, trimmed and once each. */
  readonly promptGuidelines: readonly string[];
}

/** What a conversation's extensions registered: their tools and the events they listen to. */
export interface Registrations {
  readonly tools: readonly ToolDescriptor[];
  readonly events: readonly string[];
}

export interface Opened extends Registrations {
  /**
   * Extensions that failed to load, and failures Pi caught while binding one that loaded, such as
   * a `registerProvider` it refused, which carry their event.
   */
  readonly errors: readonly (ExtensionError | HandlerError)[];
  /**
   * The extensions that loaded, by their module in the bundle, which is unique where a package's
   * source can hold several. Errors cannot tell this: an extension that loaded can report one too,
   * as for an unsupported `registerProvider`.
   */
  readonly loaded: readonly { readonly source: string; readonly path: string }[];
}

/** An extension that failed to load, with the reason. */
export interface ExtensionError {
  readonly source: string;
  readonly message: string;
}

/**
 * A handler that failed after its extension loaded, with what Pi's runner reports of it (its own
 * `ExtensionError`): the event it handled, and the error's stack when there is one.
 */
export interface HandlerError extends ExtensionError {
  readonly event: string;
  readonly stack?: string;
}

/** A tool's result, as Pi's tools return them. */
export interface ToolResult {
  readonly content: readonly unknown[];
  readonly details: unknown;
  readonly isError?: boolean;
}

type Runner = ExtensionRunner;

/**
 * The runner's dispatch methods, which the host calls with the events it builds from pi-durable's
 * hooks; each returns what Pi's runner returns, combined over every handler as Pi combines it.
 */
export interface DispatchFunctions {
  emit(key: string, event: Parameters<Runner["emit"]>[0]): Promise<unknown>;
  /** Also returns the call's input, which Pi's handlers change in place. */
  toolCall(
    key: string,
    event: Parameters<Runner["emitToolCall"]>[0],
  ): Promise<{ result: Awaited<ReturnType<Runner["emitToolCall"]>>; input: unknown }>;
  toolResult(
    key: string,
    event: Parameters<Runner["emitToolResult"]>[0],
  ): ReturnType<Runner["emitToolResult"]>;
  /** `context` handlers' messages, Pi's own kinds turned into model messages as Pi turns them. */
  context(key: string, messages: Parameters<Runner["emitContext"]>[0]): Promise<Message[]>;
  providerRequest(key: string, payload: unknown): Promise<unknown>;
  input(key: string, ...args: Parameters<Runner["emitInput"]>): ReturnType<Runner["emitInput"]>;
  /**
   * Starts a run as Pi's agent does: `before_agent_start`, from a prompt options of `cwd` and the
   * offered tools, then `agent_start`.
   */
  agentStart(
    key: string,
    trigger: AgentStartTrigger,
    cwd: string,
    activeTools: readonly string[],
  ): Promise<AgentStarted>;
  messageEnd(key: string, message: MessageEndEvent["message"]): Promise<void>;
  /** `turn_end`, whose entries and continuation are not honoured. */
  turnEnd(
    key: string,
    event: Omit<TurnEndEvent, "entries" | "continue" | "context">,
  ): Promise<void>;
  /** `session_before_compact`: whether a handler cancels it, or the compaction one wrote. */
  beforeCompact(key: string, compaction: Compaction): Promise<CompactDecision>;
}

/** What starts a run, as Pi's `before_agent_start` gets it. */
export type AgentStartTrigger = Parameters<Runner["emitBeforeAgentStart"]>[0];

/** What `before_agent_start` handlers return that the host applies. */
export interface AgentStarted {
  /** The messages they return, sent after the prompt. */
  readonly messages: Awaited<ReturnType<Runner["emitBeforeAgentStart"]>>["messages"];
  /**
   * What they add to the system prompt (`sections`, `appendSystemPrompt`, `promptGuidelines`),
   * rendered as Pi renders those parts and keyed by section name.
   */
  readonly sections: Readonly<Record<string, string>>;
  /** The tools they selected, when they changed the selection, and the tools registered now. */
  readonly selection?: { readonly names: readonly string[]; readonly registrations: Registrations };
}

/** A compaction pi-durable is about to summarize. */
export interface Compaction {
  readonly reason: "manual" | "threshold" | "overflow";
  readonly instructions: string | undefined;
  /** The ID of the first entry kept. */
  readonly firstKept: string;
  /** The messages the summary replaces. */
  readonly messages: readonly unknown[];
  readonly entries: readonly SessionEntry[];
  /** How large the context is before the compaction. */
  readonly tokensBefore: number;
  /** Whether the request that overflowed is sent again after the compaction. */
  readonly willRetry: boolean;
}

/**
 * What `session_before_compact` handlers decided: to cancel, or a compaction of their own, of
 * which pi-durable places the summary and `session_compact` reports the rest.
 */
export type CompactDecision =
  | { readonly decline: true }
  | Pick<CompactionResult, "summary" | "tokensBefore" | "details" | "usage">
  | undefined;

/** Values for the flags extensions register, by name, as Pi's command line gives them. */
export type Flags = Readonly<Record<string, boolean | string>>;

/** Provider fields the adapter refuses: Pi calls their code on the host, but it lives in the worker. */
export const unsupportedProviderFields = [
  "oauth",
  "images",
  "classifiers",
  "refreshModels",
] as const;

/** Pi composes these provider settings on the host. Executable implementations stay in the worker. */
export type ProviderSettings = Omit<
  ProviderConfig,
  "streamSimple" | (typeof unsupportedProviderFields)[number]
>;

type StreamHook = "onPayload" | "onResponse" | "onProviderStreamEvent";

/**
 * The host serves each requested hook over the same RPC channel, and cancels the request by its ID
 * (`cancelProvider`).
 */
export type WorkerStreamOptions = Omit<
  SimpleStreamOptions,
  StreamHook | "fetch" | "telemetry" | "signal"
> &
  Partial<Record<StreamHook, boolean>>;

/** What the worker serves to the host. */
export interface WorkerFunctions extends DispatchFunctions {
  /** `key` names this instance in later calls; `sessionId` is what `ctx.sessionManager` gives. */
  open(key: string, sessionId: string, cwd: string, flags: Flags): Promise<Opened>;
  registrations(key: string): Registrations;
  /**
   * Streams a model request through the instance's provider. `request` is unique on the worker
   * and names it in the host's reverse calls and in `cancelProvider`. A request that asked for tools
   * stays cancellable after it returns, while its provider may wait for their results, until the
   * host cancels it or the instance closes.
   */
  streamProvider(
    key: string,
    name: string,
    request: number,
    model: Model<Api>,
    context: TranscriptContext,
    options: WorkerStreamOptions,
  ): Promise<AssistantMessage>;
  executeTool(key: string, callId: string, name: string, args: unknown): Promise<ToolResult>;
  cancelTool(key: string, callId: string): void;
  /** Aborts the signal a model request's provider was given; a request already done is ignored. */
  cancelProvider(request: number, reason: unknown): void;
  close(key: string): Promise<void>;
  /**
   * Releases what providers keep for the instance's session, when the host gave up waiting for its
   * close; its close does not release it again.
   */
  releaseSessionResources(key: string): void;
}

/**
 * The actions extensions take that the host carries out, and the registrations a read depends on.
 */
export type Action =
  | { readonly type: "sendMessage"; readonly args: Parameters<ExtensionActions["sendMessage"]> }
  | {
      readonly type: "sendUserMessage";
      readonly args: Parameters<ExtensionActions["sendUserMessage"]>;
    }
  | { readonly type: "appendEntry"; readonly customType: string; readonly data: unknown }
  | { readonly type: "setSessionName"; readonly name: string }
  | { readonly type: "setLabel"; readonly entryId: string; readonly label: string | undefined }
  | {
      readonly type: "setActiveTools";
      readonly names: readonly string[];
      /** The registrations as the action finds them, which include a tool registered just before. */
      readonly registrations: Registrations;
    }
  /**
   * The registrations, sent before `getActiveTools` so its answer includes a tool registered just
   * before, as Pi's does: the worker's notice of it travels on another channel.
   */
  | { readonly type: "registrations"; readonly registrations: Registrations }
  | { readonly type: "setThinkingLevel"; readonly level: ThinkingLevel }
  | { readonly type: "compact"; readonly instructions: string | undefined }
  | { readonly type: "abort" }
  | { readonly type: "shutdown" };

/** What the host serves to a worker, asynchronously. */
export interface HostFunctions {
  providerEvent(request: number, event: AssistantMessageEvent): void;
  providerPayload(
    request: number,
    ...args: Parameters<NonNullable<SimpleStreamOptions["onPayload"]>>
  ): Promise<unknown>;
  providerResponse(
    request: number,
    ...args: Parameters<NonNullable<SimpleStreamOptions["onResponse"]>>
  ): Promise<void>;
  providerStreamEvent(
    request: number,
    ...args: Parameters<NonNullable<SimpleStreamOptions["onProviderStreamEvent"]>>
  ): Promise<void>;
  setModel(key: string, model: Model<Api>): Promise<boolean>;
  /**
   * `pi.exec`; `id` names the command for `cancelExec`. An `AbortSignal` stays in its thread, so
   * either side cancels what it asked the other for by its ID, as with `cancelTool` and
   * `cancelProvider`.
   */
  exec(
    key: string,
    id: number,
    command: string,
    args: string[],
    options: Omit<ExecOptions, "signal"> | undefined,
  ): Promise<ExecResult>;
  cancelExec(key: string, id: number): void;
  getApiKeyAndHeaders(
    key: string,
    model: Model<Api>,
  ): ReturnType<ModelRegistry["getApiKeyAndHeaders"]>;
  getProviderAuth(key: string, provider: string): ReturnType<ModelRegistry["getProviderAuth"]>;
  getApiKeyForProvider(
    key: string,
    provider: string,
  ): ReturnType<ModelRegistry["getApiKeyForProvider"]>;
  changed(key: string): void;
  /** A handler of the conversation's extensions failed after loading. */
  error(key: string, error: HandlerError): void;
}

/**
 * What extensions read synchronously from the host, which the worker waits for: the conversation's
 * history as `ctx.sessionManager` gives it, and its current agent and models.
 */
export interface Reads {
  getBranch(fromId?: string): SessionEntry[];
  getEntries(): SessionEntry[];
  getEntry(id: string): SessionEntry | undefined;
  getLeafId(): string | null;
  getModel(): Model<Api> | undefined;
  getContextUsage(): ContextUsage | undefined;
  getThinkingLevel(): ThinkingLevel;
  isIdle(): boolean;
  getActiveTools(): string[];
  getAllTools(): ToolInfo[];
  /** Public metadata for a provider. Credentials are read through the registry’s auth methods. */
  getProvider(name: string): Pick<Provider, "id" | "name" | "baseUrl"> | undefined;
  /** The models of the host's catalog, and which of them have credentials, as `provider/id`. */
  getModels(): { models: Model<Api>[]; available: string[] };
  /** Nothing, once the writes sent before it are done. */
  flush(): null;
}

export type ReadRequest<M extends keyof Reads = keyof Reads> = {
  readonly type: "read";
  readonly key: string;
  readonly method: M;
  readonly args: Parameters<Reads[M]>;
};

/**
 * What a worker sends on its journal channel, in order: actions that write to the conversation,
 * provider registrations, and reads; registrations and reads wait for an answer. So a read sees every
 * write an extension made before it, and a registration's failure reaches the extension's call.
 */
export type JournalMessage =
  | {
      readonly type: "registerProvider";
      readonly key: string;
      readonly name: string;
      readonly config: ProviderSettings;
      readonly customStream: boolean;
    }
  | { readonly type: "unregisterProvider"; readonly key: string; readonly name: string }
  | { readonly type: "act"; readonly key: string; readonly action: Action }
  | { [M in keyof Reads]: ReadRequest<M> }[keyof Reads];

/**
 * The host's answer to a read. A worker waits on each read before it sends anything else, and
 * without a time limit; the host sends nothing else on this channel, and one answer to each read.
 * So the next message a worker receives is the answer to its read, and needs no ID to match it. A
 * time limit on the wait, or other messages from the host here, would need IDs: a late answer, or
 * another message, would be taken for the next read's answer.
 */
export const ReadReply = Type.Union([
  Type.Object({ type: Type.Literal("value"), value: Type.Unknown() }),
  Type.Object({ type: Type.Literal("error"), error: Type.Unknown() }),
]);
export type ReadReply = Static<typeof ReadReply>;

export interface WorkerData {
  /** The bundle's runtime module and extension modules, in load order. */
  readonly runtime: string;
  readonly extensions: readonly { readonly source: string; readonly path: string }[];
  /** The `SyncMessagePort` channel end for `JournalMessage`s. */
  readonly journal: MessagePort;
  /** The channel end for everything else. */
  readonly rpc: MessagePort;
}

/**
 * A failure as it can cross to the other thread, where `deserializeError` makes it an Error again:
 * serialize-error's copy, which keeps an error's own fields, such as `code`, and makes a value that
 * is not an error one, since birpc sends a falsy rejection as a success. When even that copy holds
 * what cannot be copied, or an error's own `toJSON` made it falsy, an error with its message, since
 * birpc answers nothing when its error reply cannot be posted.
 */
export function serializedFailure(failure: unknown): unknown {
  try {
    // The clone is what gets sent, so a getter cannot give the worker another value than checked.
    const copy: unknown = structuredClone(serializeError(failure));
    if (copy) return copy;
  } catch {
    // A symbol or another value that cannot be copied, or the value's own `toJSON` threw.
  }
  // ensure-error only for a value that is not an Error: it assigns to an Error's cause.
  const message = failure instanceof Error ? failure.message : ensureError(failure).message;
  return serializeError(new Error(message));
}
