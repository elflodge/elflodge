import type { MessagePort } from "node:worker_threads";

import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ContextUsage,
  ExecOptions,
  ExecResult,
  ExtensionActions,
  ExtensionRunner,
  ModelRegistry,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";

// What crosses between the host thread and an extension worker. Values only: functions stay in the
// worker behind names, and the host keeps the pi-durable APIs the worker's calls act on.

/** One conversation's state that extensions read synchronously, sent with every change. */
export interface ConversationState {
  readonly model: Model<Api> | undefined;
  readonly thinkingLevel: ThinkingLevel;
  readonly activeTools: readonly string[];
  readonly allTools: readonly ToolInfo[];
  readonly sessionName: string | undefined;
  readonly idle: boolean;
  readonly contextUsage: ContextUsage | undefined;
  readonly systemPrompt: string;
  /** The models of the host's catalog, and which of them have credentials. */
  readonly models: readonly Model<Api>[];
  readonly available: readonly string[];
}

export type ThinkingLevel = ReturnType<ExtensionActions["getThinkingLevel"]>;

/** A tool an extension registered, as the host registers it with pi-durable. */
export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly parameters: object;
  readonly prepareArguments: boolean;
  readonly executionMode: "parallel" | "sequential" | undefined;
  readonly exposure: "direct" | "model-only" | "codemode" | "deferred" | "hidden" | undefined;
  readonly promptSnippet: string | undefined;
  readonly promptGuidelines: readonly string[] | undefined;
}

/** What a conversation's extensions registered: their tools and the events they listen to. */
export interface Registrations {
  readonly tools: readonly ToolDescriptor[];
  readonly events: readonly string[];
}

export interface Opened extends Registrations {
  readonly errors: readonly { readonly source: string; readonly error: string }[];
}

/** A tool's result, or a partial result while it runs, as Pi's tools return them. */
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
  beforeAgentStart(
    key: string,
    ...args: Parameters<Runner["emitBeforeAgentStart"]>
  ): ReturnType<Runner["emitBeforeAgentStart"]>;
  input(key: string, ...args: Parameters<Runner["emitInput"]>): ReturnType<Runner["emitInput"]>;
}

/** What the worker serves to the host. */
export interface WorkerFunctions extends DispatchFunctions {
  open(
    key: string,
    options: { readonly cwd: string; readonly state: ConversationState },
  ): Promise<Opened>;
  registrations(key: string): Registrations;
  state(key: string, state: ConversationState): void;
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

/** What the host serves to a worker. */
export interface HostFunctions {
  act(key: string, action: Action): void;
  setModel(key: string, model: Model<Api>): Promise<boolean>;
  exec(
    key: string,
    command: string,
    args: string[],
    options: ExecOptions | undefined,
  ): Promise<ExecResult>;
  getApiKeyAndHeaders(
    key: string,
    model: Model<Api>,
  ): ReturnType<ModelRegistry["getApiKeyAndHeaders"]>;
  getProviderAuth(key: string, provider: string): ReturnType<ModelRegistry["getProviderAuth"]>;
  getApiKeyForProvider(
    key: string,
    provider: string,
  ): ReturnType<ModelRegistry["getApiKeyForProvider"]>;
  toolUpdate(callId: string, partial: ToolResult): void;
  changed(key: string): void;
}

/** A synchronous read of a conversation's history: `ctx.sessionManager`'s methods. */
export interface HistoryRead {
  readonly id: number;
  readonly key: string;
  readonly method: "getBranch" | "getEntries" | "getEntry" | "getLeafId";
  readonly args: readonly unknown[];
}

export type HistoryReply =
  | { readonly id: number; readonly value: unknown }
  | { readonly id: number; readonly error: string };

export interface WorkerData {
  /** The bundle's runtime module and extension modules, in load order. */
  readonly runtime: string;
  readonly extensions: readonly { readonly source: string; readonly path: string }[];
  /** The `SyncMessagePort` channel end for history reads. */
  readonly history: MessagePort;
  /** The channel end for everything else. */
  readonly rpc: MessagePort;
}
