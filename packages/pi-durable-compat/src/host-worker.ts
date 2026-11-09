import { pathToFileURL } from "node:url";
import { workerData as startData } from "node:worker_threads";

import type { ExecOptions, ToolInfo } from "@earendil-works/pi-coding-agent";
import { createBirpc } from "birpc";
import ensureError from "ensure-error";
import { SyncMessagePort } from "sync-message-port";

import type {
  Action,
  ExtensionError,
  HostFunctions,
  JournalMessage,
  Reads,
  Registrations,
  ToolResult,
  WorkerData,
  WorkerFunctions,
} from "./protocol.ts";
import type {
  Instance,
  LoadedExtension,
  ModelRegistryFacade,
  ReadonlySessionManager,
} from "./runtime.ts";

// An extension worker: one instance of every extension per conversation it hosts, keyed by the
// conversation's provider session ID. Modules load once per worker; factories run per instance.

const workerData: WorkerData = startData;
const runtime: typeof import("./runtime.ts") = await import(pathToFileURL(workerData.runtime).href);
const extensions: LoadedExtension[] = [];
const loadErrors: ExtensionError[] = [];
for (const { source, path } of workerData.extensions) {
  try {
    const module: { default?: unknown } = await import(pathToFileURL(path).href);
    extensions.push({ source, factory: module.default });
  } catch (error) {
    loadErrors.push({ source, message: ensureError(error).message });
  }
}

const instances = new Map<string, Instance>();
const running = new Map<string, AbortController>();

const journal = new SyncMessagePort(workerData.journal);
let nextRead = 0;
let nextExec = 0;

/** Sends `action` on the journal channel, ahead of any read that follows it. */
function act(key: string, action: Action) {
  const message: JournalMessage = { type: "act", key, action };
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker port, not a window
  journal.postMessage(message);
}

/**
 * Reads from the host, blocking this worker until it answers. The reply is the host's own answer to
 * `method`, so it is typed as that, as birpc types its replies.
 */
function read<M extends keyof Reads>(
  key: string,
  method: M,
  ...args: Parameters<Reads[M]>
): ReturnType<Reads[M]> {
  const id = nextRead++;
  const message: JournalMessage = { type: "read", id, key, method, args };
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker port, not a window
  journal.postMessage(message);
  for (;;) {
    const reply = journal.receiveMessage();
    if (typeof reply !== "object" || reply === null || !("id" in reply) || reply.id !== id)
      continue;
    if ("error" in reply) throw new Error(String(reply.error));
    const value: unknown = "value" in reply ? reply.value : undefined;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the host's answer to `method`, as above
    return value as ReturnType<Reads[M]>;
  }
}

function instanceFor(key: string): Instance {
  const found = instances.get(key);
  if (!found) throw new Error(`No extensions are open for conversation ${key}`);
  return found;
}

function runnerFor(key: string) {
  return instanceFor(key).runner;
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
      defaultActive: definition.defaultActive,
    })),
    events: instance.events(),
  };
}

const functions: WorkerFunctions = {
  async open(key, cwd) {
    const instance = await runtime.createInstance(extensions, {
      cwd,
      actions: {
        sendMessage: (...args) => act(key, { type: "sendMessage", args }),
        sendUserMessage: (...args) => act(key, { type: "sendUserMessage", args }),
        appendEntry: (customType, data) => act(key, { type: "appendEntry", customType, data }),
        setSessionName: (name) => act(key, { type: "setSessionName", name }),
        getSessionName: () => undefined,
        setLabel: (entryId, label) => act(key, { type: "setLabel", entryId, label }),
        getActiveTools: () => read(key, "getActiveTools"),
        getAllTools: () => allTools(key),
        getSettings: () => ({}),
        setActiveTools: (names) => act(key, { type: "setActiveTools", names }),
        getCommands: () => [],
        setModel: async (model) => {
          const previousModel = read(key, "getModel");
          if (!(await host.setModel(key, model))) return false;
          await runnerFor(key).emit({ type: "model_select", model, previousModel, source: "set" });
          return true;
        },
        getThinkingLevel: () => read(key, "getThinkingLevel"),
        setThinkingLevel: (level) => {
          const previousLevel = read(key, "getThinkingLevel");
          act(key, { type: "setThinkingLevel", level });
          if (level === previousLevel) return;
          void runnerFor(key).emit({ type: "thinking_level_select", level, previousLevel });
        },
      },
      context: {
        getModel: () => read(key, "getModel"),
        getScopedModels: () => [],
        isIdle: () => read(key, "isIdle"),
        isProjectTrusted: () => true,
        getSignal: () => undefined,
        abort: () => act(key, { type: "abort" }),
        hasPendingMessages: () => false,
        shutdown: () => act(key, { type: "shutdown" }),
        getContextUsage: () => undefined,
        compact: (options) =>
          act(key, { type: "compact", instructions: options?.customInstructions }),
        getSystemPrompt: () => "",
      },
      sessionManager: sessionManager(key, cwd),
      modelRegistry: modelRegistry(key),
      exec: (command, args, options) => exec(key, command, args, options),
      changed: () => host.changed(key),
    });
    instances.set(key, instance);
    return { ...registrations(instance), errors: [...loadErrors, ...instance.errors] };
  },
  registrations: (key) => registrations(instanceFor(key)),
  emit: (key, event) => runnerFor(key).emit(event),
  toolCall: async (key, event) => ({
    result: await runnerFor(key).emitToolCall(event),
    input: event.input,
  }),
  toolResult: (key, event) => runnerFor(key).emitToolResult(event),
  context: (key, messages) => runnerFor(key).emitContext(messages),
  providerRequest: (key, payload) => runnerFor(key).emitBeforeProviderRequest(payload),
  input: (key, ...args) => runnerFor(key).emitInput(...args),
  async executeTool(key, callId, name, args) {
    const { runner } = instanceFor(key);
    const definition = runner.getToolDefinition(name);
    // The registry offers every attached conversation's tools; this conversation's own decide.
    if (!definition || definition.exposure === "hidden") {
      throw new Error(`Tool ${name} is not registered in this conversation`);
    }
    const controller = new AbortController();
    running.set(callId, controller);
    try {
      const params = definition.prepareArguments ? definition.prepareArguments(args) : args;
      const result = await definition.execute(
        callId,
        params,
        controller.signal,
        // pi-durable records a call's output as text it streams, which Pi's partial results are not.
        () => {},
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
    const found = instances.get(key);
    if (!found) return;
    // The instance stays open while its shutdown handlers run, which may still read and act.
    try {
      await found.runner.emit({ type: "session_shutdown", reason: "quit" });
      // What the handlers wrote travels on the journal channel, not with this reply. A read there
      // returns once the host has done those writes, so the host's close finds them done.
      read(key, "flush");
    } finally {
      instances.delete(key);
    }
  },
};

/** The host's tools, and this conversation's extensions' own with the exposure they registered. */
function allTools(key: string): ToolInfo[] {
  const own = runnerFor(key)
    .getAllRegisteredTools()
    .map(({ definition, sourceInfo }) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      exposure: definition.exposure ?? "direct",
      sourceInfo,
    }));
  const names = new Set(own.map((tool) => tool.name));
  return [...read(key, "getAllTools").filter((tool) => !names.has(tool.name)), ...own];
}

/** `pi.exec` through the host, which cancels the command when `options.signal` aborts. */
async function exec(
  key: string,
  command: string,
  args: string[],
  options: ExecOptions | undefined,
) {
  const { signal, ...rest } = options ?? {};
  const id = nextExec++;
  const cancel = () => void host.cancelExec(key, id);
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const result = host.exec(key, id, command, args, rest);
    if (signal?.aborted) cancel();
    return await result;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

function toolResult(result: {
  content: readonly unknown[];
  details?: unknown;
  isError?: boolean;
}): ToolResult {
  return {
    content: result.content,
    details: result.details,
    ...(result.isError === undefined ? {} : { isError: result.isError }),
  };
}

function unsupported(name: string) {
  return () => {
    throw new Error(`ctx.sessionManager.${name} is not supported by pi-durable-compat`);
  };
}

function sessionManager(key: string, cwd: string): ReadonlySessionManager {
  return {
    getCwd: () => cwd,
    getSessionDir: unsupported("getSessionDir"),
    getSessionId: () => key,
    getSessionFile: () => undefined,
    getLeafId: () => read(key, "getLeafId"),
    getLeafEntry: unsupported("getLeafEntry"),
    getEntry: (id) => read(key, "getEntry", id),
    getLabel: () => undefined,
    getBranch: (fromId) => read(key, "getBranch", fromId),
    buildContextEntries: unsupported("buildContextEntries"),
    buildSessionProjection: unsupported("buildSessionProjection"),
    getHeader: unsupported("getHeader"),
    getEntries: () => read(key, "getEntries"),
    getTree: unsupported("getTree"),
    getSessionName: () => undefined,
  };
}

function modelRegistry(key: string): ModelRegistryFacade {
  const models = () => read(key, "getModels");
  const available = (model: { provider: string; id: string }) =>
    models().available.includes(`${model.provider}/${model.id}`);
  return {
    find: (provider, modelId) =>
      models().models.find((m) => m.provider === provider && m.id === modelId),
    getAll: () => models().models,
    getAvailable: () => {
      const all = models();
      return all.models.filter((m) => all.available.includes(`${m.provider}/${m.id}`));
    },
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
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker port, not a window
  post: (message) => workerData.rpc.postMessage(message),
  on: (handler) => workerData.rpc.on("message", handler),
  timeout: -1,
});
