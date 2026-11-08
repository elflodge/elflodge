import { workerData as data } from "node:worker_threads";

import { createBirpc } from "birpc";
import { SyncMessagePort } from "sync-message-port";

import type {
  ConversationState,
  HistoryRead,
  HostFunctions,
  Registrations,
  ToolResult,
  WorkerData,
  WorkerFunctions,
} from "./protocol.ts";
import type { Instance, LoadedExtension, ModelRegistryFacade, ReadonlySessionManager } from "./runtime.ts";

// An extension worker: one instance of every extension per conversation it hosts, keyed by the
// conversation's provider session ID. Modules load once per worker; factories run per instance.

const workerData: WorkerData = data;
const runtime: typeof import("./runtime.ts") = await import(workerData.runtime);
const extensions: LoadedExtension[] = [];
const loadErrors: { source: string; error: string }[] = [];
for (const { source, path } of workerData.extensions) {
  try {
    const module: { default?: unknown } = await import(path);
    extensions.push({ source, factory: module.default });
  } catch (error) {
    loadErrors.push({ source, error: error instanceof Error ? error.message : String(error) });
  }
}

interface Hosted {
  readonly instance: Instance;
  state: ConversationState;
}

const hosted = new Map<string, Hosted>();
const running = new Map<string, AbortController>();

const history = new SyncMessagePort(workerData.history);
let nextRead = 0;

/**
 * Reads the conversation's history from the host, blocking this worker until it answers. The
 * reply is the host's own, answering `method` with what Pi's `SessionManager` returns, so it is
 * typed as that, as birpc types its replies.
 */
function read<M extends HistoryRead["method"]>(
  key: string,
  method: M,
  args: Parameters<ReadonlySessionManager[M]>,
): ReturnType<ReadonlySessionManager[M]> {
  const id = nextRead++;
  const request: HistoryRead = { id, key, method, args };
  history.postMessage(request);
  for (;;) {
    const reply = history.receiveMessage();
    if (typeof reply !== "object" || reply === null || !("id" in reply) || reply.id !== id) continue;
    if ("error" in reply) throw new Error(String(reply.error));
    return "value" in reply ? (reply.value as ReturnType<ReadonlySessionManager[M]>) : (undefined as ReturnType<ReadonlySessionManager[M]>);
  }
}

function hostedFor(key: string): Hosted {
  const found = hosted.get(key);
  if (!found) throw new Error(`No extensions are open for conversation ${key}`);
  return found;
}

function runnerFor(key: string) {
  return hostedFor(key).instance.runner;
}

function registrations(instance: Instance): Registrations {
  return {
    tools: instance.runner.getAllRegisteredTools().map(({ definition }) => ({
      name: definition.name,
      description: definition.description,
      // Structured cloning keeps the JSON Schema and drops TypeBox's symbol-keyed markers.
      parameters: definition.parameters,
      prepareArguments: definition.prepareArguments !== undefined,
      executionMode: definition.executionMode,
      exposure: definition.exposure,
      promptSnippet: definition.promptSnippet,
      promptGuidelines: definition.promptGuidelines,
    })),
    events: instance.events(),
  };
}

const functions: WorkerFunctions = {
  async open(key, { cwd, state }) {
    const entry: { state: ConversationState } = { state };
    const instance = await runtime.createInstance(extensions, {
      cwd,
      actions: {
        sendMessage: (...args) => host.act(key, { type: "sendMessage", args }),
        sendUserMessage: (...args) => host.act(key, { type: "sendUserMessage", args }),
        appendEntry: (customType, data) => host.act(key, { type: "appendEntry", customType, data }),
        setSessionName: (name) => host.act(key, { type: "setSessionName", name }),
        getSessionName: () => entry.state.sessionName,
        setLabel: (entryId, label) => host.act(key, { type: "setLabel", entryId, label }),
        getActiveTools: () => [...entry.state.activeTools],
        getAllTools: () => [...entry.state.allTools],
        getSettings: () => ({}),
        setActiveTools: (names) => host.act(key, { type: "setActiveTools", names }),
        getCommands: () => [],
        setModel: (model) => host.setModel(key, model),
        getThinkingLevel: () => entry.state.thinkingLevel,
        setThinkingLevel: (level) => host.act(key, { type: "setThinkingLevel", level }),
      },
      context: {
        getModel: () => entry.state.model,
        getScopedModels: () => [],
        isIdle: () => entry.state.idle,
        isProjectTrusted: () => true,
        getSignal: () => undefined,
        abort: () => host.act(key, { type: "abort" }),
        hasPendingMessages: () => false,
        shutdown: () => host.act(key, { type: "shutdown" }),
        getContextUsage: () => entry.state.contextUsage,
        compact: (options) =>
          host.act(key, { type: "compact", instructions: options?.customInstructions }),
        getSystemPrompt: () => entry.state.systemPrompt,
      },
      sessionManager: sessionManager(key, cwd),
      modelRegistry: modelRegistry(key, entry),
      exec: (command, args, options) => host.exec(key, command, args, options),
      changed: () => host.changed(key),
    });
    hosted.set(key, { instance, get state() { return entry.state; }, set state(value) { entry.state = value; } });
    return { ...registrations(instance), errors: [...loadErrors, ...instance.errors] };
  },
  registrations: (key) => registrations(hostedFor(key).instance),
  state(key, state) {
    const found = hosted.get(key);
    if (found) found.state = state;
  },
  emit: (key, event) => runnerFor(key).emit(event),
  toolCall: async (key, event) => ({ result: await runnerFor(key).emitToolCall(event), input: event.input }),
  toolResult: (key, event) => runnerFor(key).emitToolResult(event),
  context: (key, messages) => runnerFor(key).emitContext(messages),
  providerRequest: (key, payload) => runnerFor(key).emitBeforeProviderRequest(payload),
  beforeAgentStart: (key, trigger, options) => runnerFor(key).emitBeforeAgentStart(trigger, options),
  input: (key, ...args) => runnerFor(key).emitInput(...args),
  async executeTool(key, callId, name, args) {
    const { runner } = hostedFor(key).instance;
    const definition = runner.getToolDefinition(name);
    if (!definition) throw new Error(`Tool ${name} is not registered`);
    const controller = new AbortController();
    running.set(callId, controller);
    try {
      const params = definition.prepareArguments ? definition.prepareArguments(args) : args;
      const result = await definition.execute(
        callId,
        params,
        controller.signal,
        (partial) => host.toolUpdate(callId, toolResult(partial)),
        runner.createToolContext(callId, controller.signal),
      );
      return toolResult(result);
    } finally {
      running.delete(callId);
    }
  },
  cancelTool(callId) {
    running.get(callId)?.abort();
  },
  async close(key) {
    const found = hosted.get(key);
    if (!found) return;
    hosted.delete(key);
    await found.instance.runner.emit({ type: "session_shutdown", reason: "quit" });
  },
};

function toolResult(result: { content: readonly unknown[]; details?: unknown; isError?: boolean }): ToolResult {
  return { content: result.content, details: result.details, ...(result.isError === undefined ? {} : { isError: result.isError }) };
}

function sessionManager(key: string, cwd: string): ReadonlySessionManager {
  const unsupported = (name: string) => () => {
    throw new Error(`ctx.sessionManager.${name} is not supported by pi-durable-compat yet`);
  };
  return {
    getCwd: () => cwd,
    getSessionDir: unsupported("getSessionDir"),
    getSessionId: () => key,
    getSessionFile: () => undefined,
    getLeafId: () => read(key, "getLeafId", []),
    getLeafEntry: unsupported("getLeafEntry"),
    getEntry: (id) => read(key, "getEntry", [id]),
    getLabel: () => undefined,
    getBranch: (fromId) => read(key, "getBranch", [fromId]),
    buildContextEntries: unsupported("buildContextEntries"),
    buildSessionProjection: unsupported("buildSessionProjection"),
    getHeader: unsupported("getHeader"),
    getEntries: () => read(key, "getEntries", []),
    getTree: unsupported("getTree"),
    getSessionName: () => hosted.get(key)?.state.sessionName,
  };
}

function modelRegistry(key: string, entry: { state: ConversationState }): ModelRegistryFacade {
  const models = () => entry.state.models;
  const available = (model: { provider: string; id: string }) =>
    entry.state.available.includes(`${model.provider}/${model.id}`);
  return {
    find: (provider, modelId) => models().find((m) => m.provider === provider && m.id === modelId),
    getAll: () => [...models()],
    getAvailable: () => models().filter(available),
    // The catalog holds chat models only, so an extension looking for another type finds none.
    findOfType: () => undefined,
    hasConfiguredAuth: available,
    getApiKeyAndHeaders: (model) => host.getApiKeyAndHeaders(key, model),
    getProviderAuth: (provider) => host.getProviderAuth(key, provider),
    getApiKeyForProvider: (provider) => host.getApiKeyForProvider(key, provider),
    getError: () => undefined,
  };
}

const host = createBirpc<HostFunctions, WorkerFunctions>(functions, {
  post: (message) => workerData.rpc.postMessage(message),
  on: (handler) => workerData.rpc.on("message", handler),
  timeout: -1,
});
