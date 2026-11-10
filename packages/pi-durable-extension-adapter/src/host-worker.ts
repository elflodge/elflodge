import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { workerData as startData } from "node:worker_threads";

import type {
  ExecOptions,
  SessionBeforeCompactEvent,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
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
// host's route for that opening. Modules load once per worker; factories run per instance.

const workerData: WorkerData = startData;
const runtime: typeof import("./runtime.ts") = await import(pathToFileURL(workerData.runtime).href);
const extensions: LoadedExtension[] = [];
const loadErrors: ExtensionError[] = [];
for (const { source, path } of workerData.extensions) {
  try {
    const module: { default?: unknown } = await import(pathToFileURL(path).href);
    extensions.push({ source, path, factory: module.default });
  } catch (error) {
    loadErrors.push({ source, message: ensureError(error).message });
  }
}

/**
 * A conversation's extensions, with its tool calls by the model's call ID, which is unique only
 * within a conversation; they go when the conversation closes.
 */
interface Opened extends Instance {
  /** Aborted at close, after which the instance's writes are dropped. */
  readonly life: AbortController;
  readonly running: Map<string, AbortController>;
  /** Calls whose `tool_execution_start` was emitted. */
  readonly started: Set<string>;
  /** How long each finished call's `execute` took, in milliseconds, until `tool_execution_end`. */
  readonly durations: Map<string, number>;
  /** Prompts `sendUserMessage` is passing through the `input` handlers, which close waits for. */
  readonly prompts: Set<Promise<void>>;
}

const instances = new Map<string, Opened>();
type AgentMessages = SessionBeforeCompactEvent["preparation"]["messagesToSummarize"];

const journal = new SyncMessagePort(workerData.journal);
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
  const message: JournalMessage = { type: "read", key, method, args };
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker port, not a window
  journal.postMessage(message);
  // The next message is the answer to this read (`ReadReply`).
  const reply = journal.receiveMessage();
  if (typeof reply !== "object" || reply === null)
    throw new Error("The host's reply is not an object");
  if ("error" in reply) throw ensureError(reply.error);
  const value: unknown = "value" in reply ? reply.value : undefined;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the host's answer to `method`, as above
  return value as ReturnType<Reads[M]>;
}

function instanceFor(key: string): Opened {
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
      promptSnippet: promptSnippet(definition.promptSnippet),
      promptGuidelines: [
        ...new Set((definition.promptGuidelines ?? []).map((each) => each.trim()).filter(Boolean)),
      ],
    })),
    events: instance.events(),
  };
}

const functions: WorkerFunctions = {
  async open(key, sessionId, cwd, flags) {
    const life = new AbortController();
    // A write after close, such as a timer's message, is dropped rather than thrown, which would
    // end the worker with every other conversation on it. A later instance of the same conversation
    // has a key of its own, so this one's late writes, past the host's time limit, find none.
    const send = (action: Action) => {
      if (!life.signal.aborted) act(key, action);
    };
    const prompts = new Set<Promise<void>>();
    const instance = await runtime.createInstance(extensions, {
      cwd,
      flags,
      actions: {
        sendMessage: (...args) => send({ type: "sendMessage", args }),
        sendUserMessage: (content, options) => {
          if (life.signal.aborted) return;
          // A failure is reported, as Pi reports a failed `sendUserMessage` (`agent-session.js`),
          // rather than left unhandled, which would end the worker with every conversation on it.
          // One after the host let go of the instance has no one to report to and is dropped.
          const sent = prompt(key, content, options, send).catch((error: unknown) => {
            const failure = ensureError(error);
            void host.error(key, {
              source: "<runtime>",
              event: "send_user_message",
              message: failure.message,
              ...(failure.stack !== undefined && { stack: failure.stack }),
            });
          });
          prompts.add(sent);
          void sent.finally(() => prompts.delete(sent));
        },
        appendEntry: (customType, data) => send({ type: "appendEntry", customType, data }),
        setSessionName: (name) => send({ type: "setSessionName", name }),
        getSessionName: () => undefined,
        setLabel: (entryId, label) => send({ type: "setLabel", entryId, label }),
        getActiveTools: () => {
          act(key, { type: "registrations", registrations: registrations(instanceFor(key)) });
          return read(key, "getActiveTools");
        },
        getAllTools: () => allTools(key),
        getSettings: () => ({}),
        setActiveTools: (names) => {
          if (life.signal.aborted) return;
          act(key, {
            type: "setActiveTools",
            names,
            registrations: registrations(instanceFor(key)),
          });
        },
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
          send({ type: "setThinkingLevel", level });
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
        abort: () => send({ type: "abort" }),
        hasPendingMessages: () => false,
        shutdown: () => send({ type: "shutdown" }),
        getContextUsage: () => undefined,
        compact: (options) => send({ type: "compact", instructions: options?.customInstructions }),
        getSystemPrompt: () => "",
      },
      sessionManager: sessionManager(key, sessionId, cwd),
      modelRegistry: modelRegistry(key),
      exec: (command, args, options) => exec(key, command, args, options),
      changed: () => host.changed(key),
      error: (error) => host.error(key, error),
    });
    instances.set(key, {
      ...instance,
      life,
      running: new Map(),
      started: new Set(),
      durations: new Map(),
      prompts,
    });
    return {
      ...registrations(instance),
      errors: [...loadErrors, ...instance.errors],
      loaded: instance.loaded,
    };
  },
  registrations: (key) => registrations(instanceFor(key)),
  emit: (key, event) => runnerFor(key).emit(event),
  // In Pi's order: `tool_execution_start` with the arguments as the model sent them, before
  // `tool_call`, as a copy that `tool_call` handlers' edits leave alone; `tool_execution_end` with the result `tool_result` handlers made.
  async toolCall(key, event) {
    const { runner, started } = instanceFor(key);
    started.add(event.toolCallId);
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
    const { runner, started, durations } = instanceFor(key);
    const id = event.toolCallId;
    // A call pi-durable rejected before its hooks, an unknown tool or invalid arguments, had no
    // `tool_call`; Pi starts every call, those too.
    if (!started.delete(id)) {
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
        event: "before_agent_start",
        message: `Invalid system prompt section name: ${name}`,
      }),
    );
    await runner.emit({ type: "agent_start" });
    const edited = !isDeepStrictEqual(options.selectedTools, selectedTools);
    return {
      messages: started.messages,
      sections,
      // With the tools as they are now, which a handler may have just registered.
      ...(edited && {
        selection: { names: options.selectedTools, registrations: registrations(instanceFor(key)) },
      }),
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
    const { running, durations } = instance;
    running.set(callId, controller);
    const begun = performance.now();
    // As Pi's agent loop does: each partial result is a `tool_execution_update`, until `execute`
    // settles, and the result waits for the handlers. pi-durable records only text a tool streams,
    // which Pi's partial results are not, so they reach extensions alone.
    const updates: Promise<unknown>[] = [];
    let updating = true;
    try {
      const params = definition.prepareArguments ? definition.prepareArguments(args) : args;
      const result = await definition.execute(
        callId,
        params,
        controller.signal,
        (partialResult) => {
          if (!updating) return;
          updates.push(
            runner.emit({
              type: "tool_execution_update",
              toolCallId: callId,
              toolName: name,
              args,
              partialResult,
            }),
          );
        },
        runner.createToolContext(callId, controller.signal),
      );
      return toolResult(result);
    } finally {
      updating = false;
      running.delete(callId);
      // For `tool_execution_end`, which the host asks for after the result, when someone listens;
      // whole milliseconds, as Pi gives them.
      if (instance.events().includes("tool_execution_end")) {
        durations.set(callId, Math.round(performance.now() - begun));
      }
      await Promise.all(updates);
    }
  },
  cancelTool(key, callId) {
    instances.get(key)?.running.get(callId)?.abort();
  },
  async close(key) {
    const found = instances.get(key);
    if (!found) return;
    // The instance stays open while its shutdown handlers run, which may still read and act.
    try {
      await found.runner.emit({ type: "session_shutdown", reason: "quit" });
      // A prompt they sent is kept too, once the `input` handlers are done with it.
      await Promise.allSettled(found.prompts);
      // What the handlers wrote travels on the journal channel, not with this reply. A read there
      // returns once the host has done those writes, so the host's close finds them done.
      read(key, "flush");
    } finally {
      instances.delete(key);
      found.life.abort();
    }
  },
};

/**
 * An extension's prompt, through the `input` handlers first, as Pi's `sendUserMessage` sends it
 * through `prompt` with source `"extension"`: text parts joined by line breaks, images apart, and
 * the delivery told to handlers only while a run is under way.
 */
async function prompt(
  key: string,
  content: SendUserMessageArgs[0],
  options: SendUserMessageArgs[1],
  send: (action: Action) => void,
) {
  const text =
    typeof content === "string"
      ? content
      : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  const images = typeof content === "string" ? [] : content.filter((part) => part.type === "image");
  const delivery = options?.deliverAs && !read(key, "isIdle") ? options.deliverAs : undefined;
  let result: Awaited<ReturnType<Instance["runner"]["emitInput"]>>;
  try {
    result = await runnerFor(key).emitInput(
      text,
      images.length > 0 ? images : undefined,
      "extension",
      delivery,
    );
  } catch {
    // The instance closed meanwhile; what it sends now is dropped, as any late action.
    return;
  }
  if (result.action === "handled") return;
  // The joined text and the images, as Pi submits them after its `input` handlers.
  const submitted = result.action === "continue" ? { text, images } : result;
  const sent = submitted.images?.length
    ? [{ type: "text" as const, text: submitted.text }, ...submitted.images]
    : submitted.text;
  send({ type: "sendUserMessage", args: [sent, options] });
}

type SendUserMessageArgs = Extract<Action, { type: "sendUserMessage" }>["args"];

/** A tool's snippet on one line, as Pi's `AgentSession` lists it; none when it is blank. */
function promptSnippet(text: string | undefined) {
  return text?.replaceAll(/\s+/g, " ").trim() || undefined;
}

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
  // Rendered as Pi renders a section, and keyed apart from pi-durable's own sections, which the
  // same request carries: unprefixed, an extension's `rules` would replace pi-durable's.
  const tagged = (name: string, content: string) => {
    sections[`pi-extensions-${name}`] = `<${name}>\n${content}\n</${name}>`;
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
    throw new Error(`ctx.sessionManager.${name} is not supported by pi-durable-extension-adapter`);
  };
}

function sessionManager(key: string, sessionId: string, cwd: string): ReadonlySessionManager {
  return {
    getCwd: () => cwd,
    getSessionDir: unsupported("getSessionDir"),
    getSessionId: () => sessionId,
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
  // No time limit: `exec` and model calls run as long as they need, and the host either answers or
  // ends this worker, and its calls with it.
  timeout: -1,
  // Notices that need no answer, so none is left waiting when the worker or the host goes.
  eventNames: ["changed", "cancelExec", "error"],
});
