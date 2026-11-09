import type { MessagePort } from "node:worker_threads";

import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExecOptions,
  ExecResult,
  ExtensionActions,
  ExtensionRunner,
  ModelRegistry,
  SessionEntry,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";

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
}

/** What a conversation's extensions registered: their tools and the events they listen to. */
export interface Registrations {
  readonly tools: readonly ToolDescriptor[];
  readonly events: readonly string[];
}

export interface Opened extends Registrations {
  readonly errors: readonly ExtensionError[];
}

/** An extension that failed to load, with the reason. */
export interface ExtensionError {
  readonly source: string;
  readonly message: string;
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
  context(
    key: string,
    messages: Parameters<Runner["emitContext"]>[0],
  ): ReturnType<Runner["emitContext"]>;
  providerRequest(key: string, payload: unknown): Promise<unknown>;
  input(key: string, ...args: Parameters<Runner["emitInput"]>): ReturnType<Runner["emitInput"]>;
}

/** What the worker serves to the host. */
export interface WorkerFunctions extends DispatchFunctions {
  open(key: string, cwd: string): Promise<Opened>;
  registrations(key: string): Registrations;
  executeTool(key: string, callId: string, name: string, args: unknown): Promise<ToolResult>;
  cancelTool(callId: string): void;
  close(key: string): Promise<void>;
}

/** The actions extensions take that the host carries out. */
export type Action =
  | { readonly type: "sendMessage"; readonly args: Parameters<ExtensionActions["sendMessage"]> }
  | {
      readonly type: "sendUserMessage";
      readonly args: Parameters<ExtensionActions["sendUserMessage"]>;
    }
  | { readonly type: "appendEntry"; readonly customType: string; readonly data: unknown }
  | { readonly type: "setSessionName"; readonly name: string }
  | { readonly type: "setLabel"; readonly entryId: string; readonly label: string | undefined }
  | { readonly type: "setActiveTools"; readonly names: readonly string[] }
  | { readonly type: "setThinkingLevel"; readonly level: ThinkingLevel }
  | { readonly type: "compact"; readonly instructions: string | undefined }
  | { readonly type: "abort" }
  | { readonly type: "shutdown" };

/** What the host serves to a worker, asynchronously. */
export interface HostFunctions {
  setModel(key: string, model: Model<Api>): Promise<boolean>;
  /** `pi.exec`; `id` names the command for `cancelExec`, as an `AbortSignal` cannot cross. */
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
  getThinkingLevel(): ThinkingLevel;
  isIdle(): boolean;
  getActiveTools(): string[];
  getAllTools(): ToolInfo[];
  /** The models of the host's catalog, and which of them have credentials, as `provider/id`. */
  getModels(): { models: Model<Api>[]; available: string[] };
  /** Nothing, once the writes sent before it are done. */
  flush(): null;
}

/**
 * What a worker sends on its journal channel, in order: actions that write to the conversation and
 * reads that wait for an answer, so a read sees every write an extension made before it.
 */
export type JournalMessage =
  | { readonly type: "act"; readonly key: string; readonly action: Action }
  | {
      readonly type: "read";
      readonly id: number;
      readonly key: string;
      readonly method: keyof Reads;
      readonly args: readonly unknown[];
    };

export type ReadReply =
  | { readonly id: number; readonly value: unknown }
  | { readonly id: number; readonly error: string };

export interface WorkerData {
  /** The bundle's runtime module and extension modules, in load order. */
  readonly runtime: string;
  readonly extensions: readonly { readonly source: string; readonly path: string }[];
  /** The `SyncMessagePort` channel end for `JournalMessage`s. */
  readonly journal: MessagePort;
  /** The channel end for everything else. */
  readonly rpc: MessagePort;
}
