import { pathToFileURL } from "node:url";
import { workerData as startData } from "node:worker_threads";

import type {
  ExecOptions,
  SessionBeforeCompactEvent,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { createBirpc } from "birpc";
import * as Equal from "effect/Equal";
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
/** Tool calls running, by conversation and call ID: a call ID is the model's, unique only in its conversation. */
const running = new Map<string, AbortController>();
/** Tool calls whose `tool_execution_start` was emitted, by conversation and call ID. */
const startedCalls = new Set<string>();
const callKey = (key: string, callId: string) => `${key}\0${callId}`;
type AgentMessages = SessionBeforeCompactEvent["preparation"]["messagesToSummarize"];

/**
 * How long each finished tool call's `execute` took, in milliseconds, until `tool_execution_end`,
 * by conversation and call ID.
 */
const durations = new Map<string, number>();

const journal = new SyncMessagePort(workerData.journal);
let nextRead = 0;
let nextExec = 0;

/** Sends `action` on the journal channel, ahead of any read that follows it. */
function act(key: string, action: Action) {
  // What the host writes to the journal must be JSON; a value that is not, such as a BigInt,
  // throws in the extension's own call, as Pi's session file makes it.
  JSON.stringify(action);
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
        setActiveTools: (names) =>
          act(key, {
            type: "setActiveTools",
            names,
            registrations: registrations(instanceFor(key)),
          }),
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
      error: (error) => host.error(key, error),
    });
    instances.set(key, instance);
    return { ...registrations(instance), errors: [...loadErrors, ...instance.errors] };
  },
  registrations: (key) => registrations(instanceFor(key)),
  emit: (key, event) => runnerFor(key).emit(event),
  // In Pi's order: `tool_execution_start` with the arguments as the model sent them, before
  // `tool_call`, as a copy that `tool_call` handlers' edits leave alone; `tool_execution_end` with the result `tool_result` handlers made.
  async toolCall(key, event) {
    const runner = runnerFor(key);
    startedCalls.add(callKey(key, event.toolCallId));
    await runner.emit({
      type: "tool_execution_start",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: structuredClone(event.input),
    });
    const result = await runner.emitToolCall(event);
    return { result, input: event.input };
  },
  async toolResult(key, event) {
    const runner = runnerFor(key);
    const id = callKey(key, event.toolCallId);
    // A call pi-durable rejected before its hooks, an unknown tool or invalid arguments, had no
    // `tool_call`; Pi starts every call, those too.
    if (!startedCalls.delete(id)) {
      await runner.emit({
        type: "tool_execution_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.input,
      });
    }
    const changed = await runner.emitToolResult(event);
    const durationMs = durations.get(id);
    durations.delete(id);
    await runner.emit({
      type: "tool_execution_end",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      // Pi's runner returns every field when a handler changes any, `details: null` included.
      result: changed
        ? { content: changed.content ?? event.content, details: changed.details }
        : { content: event.content, details: event.details },
      isError: changed?.isError ?? event.isError,
      ...(durationMs !== undefined && { durationMs }),
    });
    return changed;
  },
  context: async (key, messages) =>
    runtime.convertToLlm(await runnerFor(key).emitContext(messages)),
  providerRequest: (key, payload) => runnerFor(key).emitBeforeProviderRequest(payload),
  input: (key, ...args) => runnerFor(key).emitInput(...args),
  async agentStart(key, trigger, cwd, activeTools) {
    const runner = runnerFor(key);
    const selectedTools = [...activeTools];
    const started = await runner.emitBeforeAgentStart(trigger, { cwd, selectedTools });
    const options = started.systemPromptOptions;
    const sections = promptSections(options, (name) =>
      // Pi fails the run before `agent_start`; a request's hook cannot, so the section is left out.
      host.error(key, {
        source: "before_agent_start",
        message: `Invalid system prompt section name: ${name}`,
      }),
    );
    await runner.emit({ type: "agent_start" });
    const edited = !Equal.equals(options.selectedTools, selectedTools);
    return {
      messages: started.messages,
      sections,
      ...(edited && { selectedTools: options.selectedTools }),
    };
  },
  async messageEnd(key, message) {
    await runnerFor(key).emitMessageEnd({ type: "message_end", message });
  },
  async turnEnd(key, event) {
    await runnerFor(key).emitBoundary(event, () => ({
      contextEntries: [],
      contextMessages: [],
      llmMessages: [],
      pendingMessages: [],
      canContinue: false,
    }));
  },
  async beforeCompact(key, { reason, instructions, firstKept, messages, entries }) {
    const result = await runnerFor(key).emit({
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: firstKept,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pi-durable's messages, which Pi's agent messages include
        messagesToSummarize: messages as AgentMessages,
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 0,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: runtime.DEFAULT_COMPACTION_SETTINGS,
      },
      branchEntries: [...entries],
      customInstructions: instructions,
      reason,
      willRetry: false,
      signal: new AbortController().signal,
    });
    if (result?.cancel) return { cancel: true };
    const summary = result?.compaction?.summary;
    return summary === undefined ? undefined : { summary };
  },
  async executeTool(key, callId, name, args) {
    const instance = instanceFor(key);
    const { runner } = instance;
    const definition = runner.getToolDefinition(name);
    // The registry offers every attached conversation's tools; this conversation's own decide.
    if (!definition || definition.exposure === "hidden") {
      throw new Error(`Tool ${name} is not registered in this conversation`);
    }
    const controller = new AbortController();
    const id = callKey(key, callId);
    running.set(id, controller);
    const begun = performance.now();
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
      running.delete(id);
      // For `tool_execution_end`, which the host asks for after the result, when someone listens;
      // whole milliseconds, as Pi gives them.
      if (instance.events().includes("tool_execution_end")) {
        durations.set(id, Math.round(performance.now() - begun));
      }
    }
  },
  cancelTool(key, callId) {
    running.get(callKey(key, callId))?.abort();
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
      // As Pi's session does when it is disposed: a call through the closed instance's API, such as
      // a timer firing later, throws instead of acting for a conversation attached again.
      found.runner.invalidate();
    }
  },
};

/** The section names Pi accepts, as `core/system-prompt.js` checks them. */
const SECTION_NAME = /^[a-z][a-z0-9_-]*$/;

/**
 * What `before_agent_start` handlers added to the system prompt, rendered as Pi renders those
 * parts in `buildSystemPromptSections` (pi-coding-agent's `core/system-prompt.js`): their
 * guidelines, trimmed and once each, as Pi adds them to its rules; the appended text as the
 * addendum; then their own sections, whose names Pi checks, `invalid` getting each it rejects. That
 * function builds Pi's whole prompt and puts its own default rules among the guidelines, so it is
 * not called: pi-durable builds the prompt, and Pi's preamble, tools, default rules and skills have
 * no counterpart here.
 */
function promptSections(
  options: {
    promptGuidelines: string[];
    appendSystemPrompt: string;
    sections: Record<string, string>;
  },
  invalid: (name: string) => void,
): Record<string, string> {
  const sections: Record<string, string> = {};
  // Keyed apart from pi-durable's own sections, which the same request carries.
  const tagged = (name: string, content: string) => {
    sections[`pi-extensions.${name}`] = `<${name}>\n${content}\n</${name}>`;
  };
  const guidelines = [
    ...new Set(options.promptGuidelines.map((each) => each.trim()).filter(Boolean)),
  ];
  if (guidelines.length > 0) tagged("rules", guidelines.map((each) => `- ${each}`).join("\n"));
  if (options.appendSystemPrompt) tagged("addendum", options.appendSystemPrompt);
  for (const [name, content] of Object.entries(options.sections)) {
    if (!SECTION_NAME.test(name) || name === "preamble") invalid(name);
    else if (content) tagged(name, content);
  }
  return sections;
}

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
  // Notices that need no answer, so none is left waiting when the worker or the host goes.
  eventNames: ["changed", "cancelExec", "error"],
});
