import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  awaitWithContext,
  BACKGROUND_CONTEXT as context,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { createModels, type Message } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  type Conversation,
  createRegistry,
  defineExtension,
  defineTool,
  type Extension,
  GenerationTask,
  Harness,
  hook,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, onTestFinished, test } from "vite-plus/test";

import { type ExtensionHostOptions, startExtensionHost, type WorkerExit } from "../src/host.ts";
import { prepareExtensions } from "../src/prepare.ts";

const fixture = path.join(import.meta.dirname, "fixtures", "notes");

function toolResults(messages: readonly Message[]) {
  return messages.flatMap((message) =>
    message.role === "toolResult"
      ? [
          {
            tool: message.toolName,
            text: message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
            isError: message.isError,
          },
        ]
      : [],
  );
}

// The default selection leaves out the extensions attaching installs, as `attach` requires.
const settings = { extensions: [] };

/** The tools a request offers: those its system messages add and do not remove again. */
function offeredTools(messages: readonly Message[]) {
  const tools = new Set<string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  }
  return [...tools];
}

test("a conversation runs an extension's tools, saved entries, gate and input transform", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-durable-extension-adapter-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const prepared = await prepareExtensions({ sources: [fixture], dir });
  expect(prepared.failures).toEqual([]);
  const host = startExtensionHost({ prepared });
  onTestFinished(() => host.close());

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  let seen: readonly Message[] = [];
  faux.setResponses([
    // The tags arrive as JSON text: pi-durable validates them on the host, where an array sent as
    // text is parsed for a tool with `prepareArguments`, before the tool's own runs in the worker.
    fauxAssistantMessage([fauxToolCall("remember", { text: "milk", tags: '["shop"]' })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxToolCall("remember", { text: "eggs", tags: [] })], {
      stopReason: "toolUse",
    }),
    // Saved already, which the extension's `tool_call` handler reads from the session.
    fauxAssistantMessage([fauxToolCall("remember", { text: "milk", tags: [] })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxToolCall("recall", { order: "newest" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("danger", {})], { stopReason: "toolUse" }),
    (request) => {
      seen = request.messages;
      return fauxAssistantMessage([fauxText("Done.")]);
    },
  ]);
  const registry = createRegistry();
  const harness = await Harness.open(new MemoryStorage(), { models, registry, settings }, context);
  onTestFinished(() => harness.close(context));
  const conversation = await harness.root(context, {
    agent: { model: { provider: model.provider, modelId: model.id }, instructions: "Be brief." },
  });
  const extensions = await host.attach(
    { harness, conversation, registry, models, cwd: dir },
    context,
  );
  expect(extensions.errors).toEqual([]);

  // Idle, so the handlers are not told how it would be queued.
  const input = await extensions.input("Note my shopping", { streamingBehavior: "steer" });
  expect(input).toEqual({
    action: "transform",
    text: "Note my shopping (rpc)",
    images: undefined,
  });
  const submission = await conversation.submit(
    { type: "input", content: "Note my shopping (rpc)" },
    context,
  );
  await submission.wait(context);

  expect(toolResults(seen)).toEqual([
    { tool: "remember", text: "Saved milk (1)", isError: false },
    { tool: "remember", text: "Saved eggs (2)", isError: false },
    { tool: "remember", text: expect.stringContaining("Already saved"), isError: true },
    {
      tool: "recall",
      text: JSON.stringify([
        { text: "eggs", tags: [] },
        { text: "milk", tags: ["shop"] },
      ]),
      isError: false,
    },
    { tool: "danger", text: expect.stringContaining("Not allowed"), isError: true },
  ]);
  // The extension's `context` handler leaves the system prompt in place, as Pi does, which lists
  // the tool's snippet and guidelines as Pi lists an active tool's.
  const system = seen.find((message) => message.role === "system");
  expect(system?.role === "system" && system.sections).toMatchObject({
    "pi-extensions-tools": "<tools>\n- remember: Save a note for later\n</tools>",
    "pi-extensions-tool-rules": "<rules>\n- Save each note once\n</rules>",
  });
  await extensions.close();
});

test("an extension's own prompt goes through the input handlers", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-durable-extension-adapter-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const host = startExtensionHost({
    prepared: await prepareExtensions({ sources: [fixture], dir }),
  });
  onTestFinished(() => host.close());

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const followUp = Promise.withResolvers<readonly Message[]>();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("nudge", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Done.")]),
    (request) => {
      followUp.resolve(request.messages);
      return fauxAssistantMessage([fauxText("Checked.")]);
    },
  ]);
  const registry = createRegistry();
  const harness = await Harness.open(new MemoryStorage(), { models, registry, settings }, context);
  onTestFinished(() => harness.close(context));
  const conversation = await harness.root(context, {
    agent: { model: { provider: model.provider, modelId: model.id } },
  });
  const extensions = await host.attach(
    { harness, conversation, registry, models, cwd: dir },
    context,
  );
  onTestFinished(() => extensions.close());

  await conversation.submit({ type: "input", content: "Nudge me" }, context);

  // Sent during the run, so the handlers are told how it is queued, as Pi tells them.
  expect((await followUp.promise).at(-1)).toMatchObject({
    role: "user",
    content: "Check the notes (extension, followUp)",
  });
});

test("conversations attached through one registry each have their own extensions and tools", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-durable-extension-adapter-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const host = startExtensionHost({
    prepared: await prepareExtensions({ sources: [fixture], dir }),
  });
  onTestFinished(() => host.close());

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const seen: (readonly Message[])[] = [];
  const done = (request: { messages: readonly Message[] }) => {
    seen.push(request.messages);
    return fauxAssistantMessage([fauxText("Done.")]);
  };
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("remember", { text: "milk", tags: [] })], {
      stopReason: "toolUse",
    }),
    done,
    fauxAssistantMessage([fauxToolCall("recall", { order: "oldest" })], { stopReason: "toolUse" }),
    done,
  ]);
  const registry = createRegistry();
  const harness = await Harness.open(new MemoryStorage(), { models, registry, settings }, context);
  onTestFinished(() => harness.close(context));
  const agent = { model: { provider: model.provider, modelId: model.id } };
  const first = await harness.root(context, { agent });
  const second = await harness.createConversation(
    { ownership: { kind: "ownerless" }, agent },
    context,
  );
  for (const [conversation, tool] of [
    [first, "github"],
    [second, "postgres"],
  ] as const) {
    const flags = { tool };
    await host.attach({ harness, conversation, registry, models, cwd: dir, flags }, context);
  }

  await (await first.submit({ type: "input", content: "Note milk" }, context)).wait(context);
  await (
    await second.submit({ type: "input", content: "What did I note?" }, context)
  ).wait(context);

  // The second conversation's extension instance reads its own history, where nothing was saved.
  expect(seen.map(toolResults)).toEqual([
    [{ tool: "remember", text: "Saved milk (1)", isError: false }],
    [{ tool: "recall", text: "[]", isError: false }],
  ]);
  // Each is offered the tools its own extensions registered, and not the other's.
  const [firstTools, secondTools] = seen.map(offeredTools);
  expect(firstTools).toContain("github");
  expect(firstTools).not.toContain("postgres");
  expect(secondTools).toContain("postgres");
  expect(secondTools).not.toContain("github");
});

test("attach fails while the default selection selects the conversations' extensions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-durable-extension-adapter-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const host = startExtensionHost({
    prepared: await prepareExtensions({ sources: [fixture], dir }),
  });
  onTestFinished(() => host.close());
  const models = createModels();
  const registry = createRegistry();
  // Read at every use, so the test can drop it as an app reopening its Harness without it would.
  let defaults: Extension[] | undefined;
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      settings: {
        get extensions() {
          return defaults;
        },
      },
    },
    context,
  );
  onTestFinished(() => harness.close(context));
  const conversation = async () =>
    harness.createConversation({ ownership: { kind: "ownerless" } }, context);
  const attach = async (each: Conversation) =>
    host.attach({ harness, conversation: each, registry, models, cwd: dir }, context);
  const missing = /settings\.extensions/;

  await expect(attach(await conversation())).rejects.toThrow(missing);

  defaults = [];
  const first = await conversation();
  const second = await conversation();
  await attach(first);
  await (await attach(second)).close();
  defaults = undefined;
  // The second names its own extension from before, and would select the first's by default.
  await expect(attach(second)).rejects.toThrow(missing);
  // One that selects exactly what it stores would be selected by the first's default.
  const exact = await harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { extensions: [] } },
    context,
  );
  await expect(attach(exact)).rejects.toThrow(missing);
});

test("a run's lifecycle reaches the extensions, which add to its prompt and select tools", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-durable-extension-adapter-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const host = startExtensionHost({
    prepared: await prepareExtensions({
      sources: [path.join(import.meta.dirname, "fixtures", "lifecycle")],
      dir,
    }),
  });
  onTestFinished(() => host.close());

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const requests: { messages: readonly Message[]; tools: string[] }[] = [];
  const record = (request: { messages: readonly Message[] }) =>
    requests.push({ messages: request.messages, tools: offeredTools(request.messages) });
  faux.setResponses([
    // A failure pi-durable retries, whose retry must carry what the run's start added.
    (request) => {
      record(request);
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Unavailable" });
    },
    (request) => {
      record(request);
      return fauxAssistantMessage([fauxText("Done.")]);
    },
    (request) => {
      record(request);
      return fauxAssistantMessage([fauxToolCall("events", {})], { stopReason: "toolUse" });
    },
    (request) => {
      record(request);
      return fauxAssistantMessage([fauxText("Done.")]);
    },
  ]);
  const registry = createRegistry();
  const harness = await Harness.open(new MemoryStorage(), { models, registry, settings }, context);
  onTestFinished(() => harness.close(context));
  const conversation = await harness.root(context, {
    agent: { model: { provider: model.provider, modelId: model.id } },
  });
  const extensions = await host.attach(
    { harness, conversation, registry, models, cwd: dir },
    context,
  );
  expect(extensions.errors).toEqual([]);

  await (await conversation.submit({ type: "input", content: "hi" }, context)).wait(context);
  await (await conversation.submit({ type: "input", content: "again" }, context)).wait(context);

  const [first, retried, second, third] = requests;
  for (const request of [first, retried]) {
    const system = request?.messages.find((message) => message.role === "system");
    expect(Object.values(system?.role === "system" ? (system.sections ?? {}) : {})).toContain(
      "<notes>\nAnswer in French.\n</notes>",
    );
    expect(request?.messages.at(-1)).toMatchObject({
      role: "user",
      content: "Remember the notes.",
    });
  }
  // The tool `before_agent_start` activates is offered from the next request, as pi-durable fixes
  // a request's tools before its hooks run.
  expect(first?.tools).not.toContain("events");
  expect(second?.tools).toContain("events");
  // As in Pi, the selection removes the tool it leaves out, and tools registered just before and
  // after it are offered.
  expect(first?.tools).toContain("dropped");
  expect(second?.tools).not.toContain("dropped");
  expect(second?.tools).toEqual(expect.arrayContaining(["earlier", "later"]));
  // What the extension saw by the time its tool ran in the second run.
  const seen = [
    "before_agent_start hi",
    "agent_start",
    "turn_start",
    // The failed attempt's turn too, as in Pi.
    "message_end",
    "turn_end",
    "turn_start",
    "message_end",
    "turn_end",
    "agent_end",
    "agent_settled",
    "before_agent_start again",
    "agent_start",
    "turn_start",
    "message_end",
    "tool_execution_start",
  ];
  expect(toolResults(third?.messages ?? [])).toEqual([
    { tool: "events", text: seen.join(", "), isError: false },
  ]);

  // Closed right after the answer, its session ends after the run, as in Pi.
  await extensions.close();
  const {
    items: [saved],
  } = await conversation.entries({ order: "descending" }, 1, undefined, context);
  expect(saved).toMatchObject({
    kind: "piext.seen",
    data: {
      events: [
        ...seen,
        "tool_execution_end",
        "turn_end",
        "turn_start",
        "message_end",
        "turn_end",
        "agent_end",
        "agent_settled",
      ],
    },
  });
});

test("a run's prompt additions reach its later rounds after the host restarts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-durable-extension-adapter-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const prepared = await prepareExtensions({
    sources: [path.join(import.meta.dirname, "fixtures", "lifecycle")],
    dir,
  });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  let last: readonly Message[] = [];
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("pause", {})], { stopReason: "toolUse" }),
    (request) => {
      last = request.messages;
      return fauxAssistantMessage([fauxText("Done.")]);
    },
  ]);
  // A tool that waits until the process stops the first time, then returns.
  const paused = Promise.withResolvers<void>();
  let restarted = false;
  const pause = defineTool({
    name: "pause",
    description: "Wait",
    parameters: { type: "object", properties: {} },
    replay: "safe",
    async execute(_args, _api, call) {
      if (restarted) return { output: [{ type: "text", text: "ok" }] };
      paused.resolve();
      return awaitWithContext(new Promise<never>(() => {}), call);
    },
  });
  const start = async () => {
    const registry = createRegistry();
    const app = defineExtension({ name: "app", tools: [pause] });
    registry.install(app);
    const host = startExtensionHost({ prepared });
    const storage = await openNodeSqliteStorage(path.join(dir, "session.db"));
    const harness = await Harness.open(
      storage,
      { models, registry, settings: { extensions: [app] } },
      context,
    );
    const conversation = await harness.root(context, {
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    await host.attach({ harness, conversation, registry, models, cwd: dir }, context);
    return { host, harness, conversation };
  };

  const before = await start();
  const submission = await before.conversation.submit({ type: "input", content: "hi" }, context);
  await paused.promise;
  await before.harness.close(context);
  await before.host.close();
  restarted = true;
  const after = await start();
  onTestFinished(() => after.harness.close(context));
  onTestFinished(() => after.host.close());
  await (await after.harness.submission(submission.id, context))?.wait(context);

  const system = last.find((message) => message.role === "system");
  expect(Object.values(system?.role === "system" ? (system.sections ?? {}) : {})).toContain(
    "<notes>\nAnswer in French.\n</notes>",
  );
});

test("a run the application continues starts once for the extensions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-durable-extension-adapter-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const host = startExtensionHost({
    prepared: await prepareExtensions({
      sources: [path.join(import.meta.dirname, "fixtures", "lifecycle")],
      dir,
    }),
  });
  onTestFinished(() => host.close());

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  let last: readonly Message[] = [];
  faux.setResponses([
    fauxAssistantMessage([fauxText("Done.")]),
    fauxAssistantMessage([fauxToolCall("events", {})], { stopReason: "toolUse" }),
    (request) => {
      last = request.messages;
      return fauxAssistantMessage([fauxText("Done.")]);
    },
  ]);
  const registry = createRegistry();
  // An application's own extension that continues the run once after its first answer.
  let continued = false;
  const keepGoing = defineExtension({
    name: "keep-going",
    hooks: [
      hook(GenerationTask, {
        onYield: () => {
          if (continued) return undefined;
          continued = true;
          return { continue: "Keep going." };
        },
      }),
    ],
  });
  registry.install(keepGoing);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, settings: { extensions: [keepGoing] } },
    context,
  );
  onTestFinished(() => harness.close(context));
  const conversation = await harness.root(context, {
    agent: { model: { provider: model.provider, modelId: model.id } },
  });
  const extensions = await host.attach(
    { harness, conversation, registry, models, cwd: dir },
    context,
  );

  await (await conversation.submit({ type: "input", content: "hi" }, context)).wait(context);

  const events = toolResults(last)[0]?.text.split(", ") ?? [];
  expect(events.filter((event) => event.startsWith("before_agent_start"))).toEqual([
    "before_agent_start hi",
  ]);
  expect(events.filter((event) => event === "agent_start")).toHaveLength(1);
  expect(events.filter((event) => event === "turn_start")).toHaveLength(2);
  await extensions.close();
});

test("extensions read the flag values given to attach, and an unknown one is reported", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-durable-extension-adapter-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const host = startExtensionHost({
    prepared: await prepareExtensions({
      sources: [path.join(import.meta.dirname, "fixtures", "worker")],
      dir,
    }),
  });
  onTestFinished(() => host.close());

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  let seen: readonly Message[] = [];
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("greet", {})], { stopReason: "toolUse" }),
    (request) => {
      seen = request.messages;
      return fauxAssistantMessage([fauxText("Done.")]);
    },
  ]);
  const registry = createRegistry();
  const harness = await Harness.open(new MemoryStorage(), { models, registry, settings }, context);
  onTestFinished(() => harness.close(context));
  const conversation = await harness.root(context, {
    agent: { model: { provider: model.provider, modelId: model.id } },
  });
  const extensions = await host.attach(
    {
      harness,
      conversation,
      registry,
      models,
      cwd: dir,
      flags: { greeting: "bonjour", greting: "salut" },
    },
    context,
  );
  expect(extensions.errors).toEqual([{ source: "flags", message: "Unknown option: --greting" }]);
  await (await conversation.submit({ type: "input", content: "hi" }, context)).wait(context);

  expect(toolResults(seen)).toEqual([{ tool: "greet", text: "bonjour", isError: false }]);
  await extensions.close();
});

test("attach stops waiting for extensions that never open once its context is cancelled", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-durable-extension-adapter-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const host = startExtensionHost({
    prepared: await prepareExtensions({
      sources: [path.join(import.meta.dirname, "fixtures", "stuck")],
      dir,
    }),
  });
  onTestFinished(() => host.close());

  const models = createModels();
  const registry = createRegistry();
  const harness = await Harness.open(new MemoryStorage(), { models, registry, settings }, context);
  onTestFinished(() => harness.close(context));
  const conversation = await harness.root(context, {});
  const started = performance.now();
  const attaching = host.attach(
    { harness, conversation, registry, models, cwd: dir },
    withAbortSignal(AbortSignal.timeout(100), context),
  );

  // The caller's own deadline, well before the package's limit for stuck extensions.
  await expect(attaching).rejects.toMatchObject({ name: "TimeoutError" });
  expect(performance.now() - started).toBeLessThan(2_000);
});

/** A conversation with a fixture extension, by default `worker`, and a tool of the application's own, `echo`. */
async function workerConversation({
  extension = "worker",
  ...options
}: Pick<ExtensionHostOptions, "restart" | "workerOptions"> & { extension?: string } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-durable-extension-adapter-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const exits: ({ message: string } & WorkerExit)[] = [];
  const host = startExtensionHost({
    prepared: await prepareExtensions({
      sources: [path.join(import.meta.dirname, "fixtures", extension)],
      dir,
    }),
    ...options,
    onWorkerExit: (error, { reopened, lost }) =>
      exits.push({ message: error.message, reopened, lost }),
  });
  onTestFinished(() => host.close());

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const registry = createRegistry();
  const app = defineExtension({
    name: "app",
    tools: [
      defineTool({
        name: "echo",
        description: "Echo",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ output: [{ type: "text", text: "echoed" }] }),
      }),
    ],
  });
  registry.install(app);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, settings: { extensions: [app] } },
    context,
  );
  onTestFinished(() => harness.close(context));
  const conversation = await harness.root(context, {
    agent: { model: { provider: model.provider, modelId: model.id } },
  });
  const extensions = await host.attach(
    { harness, conversation, registry, models, cwd: dir },
    context,
  );
  onTestFinished(() => extensions.close());
  return { faux, conversation, extensions, exits };
}

test("a conversation whose extension worker exited gets its extensions back on another", async () => {
  const { faux, conversation, exits } = await workerConversation();
  let seen: readonly Message[] = [];
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("crash", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("greet", {})], { stopReason: "toolUse" }),
    (request) => {
      seen = request.messages;
      return fauxAssistantMessage([fauxText("Done.")]);
    },
  ]);
  await (await conversation.submit({ type: "input", content: "hi" }, context)).wait(context);

  expect(toolResults(seen)).toEqual([
    { tool: "crash", text: expect.stringContaining("exited"), isError: true },
    { tool: "greet", text: "hello", isError: false },
  ]);
  expect(exits).toEqual([
    { message: expect.stringContaining("exited"), reopened: [conversation.id], lost: [] },
  ]);
});

test("without restart, a conversation whose extension worker exited goes on with its other tools", async () => {
  const { faux, conversation, exits } = await workerConversation({ restart: false });
  let seen: readonly Message[] = [];
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("crash", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("greet", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("echo", {})], { stopReason: "toolUse" }),
    (request) => {
      seen = request.messages;
      return fauxAssistantMessage([fauxText("Done.")]);
    },
  ]);
  await (await conversation.submit({ type: "input", content: "hi" }, context)).wait(context);

  expect(toolResults(seen)).toEqual([
    { tool: "crash", text: expect.stringContaining("exited"), isError: true },
    { tool: "greet", text: expect.stringContaining("exited"), isError: true },
    { tool: "echo", text: "echoed", isError: false },
  ]);
  expect(exits).toEqual([
    { message: expect.stringContaining("exited"), reopened: [], lost: [conversation.id] },
  ]);
});

test("a conversation whose extensions fail to load again is lost, and its gate blocks its tools", async () => {
  const marker = path.join(
    await mkdtemp(path.join(tmpdir(), "pi-durable-extension-adapter-")),
    "loaded",
  );
  onTestFinished(() => rm(path.dirname(marker), { recursive: true, force: true }));
  const { faux, conversation, extensions, exits } = await workerConversation({
    extension: "gate",
    workerOptions: { env: { ...process.env, GATE_MARKER: marker } },
  });
  let seen: readonly Message[] = [];
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("crash", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("echo", {})], { stopReason: "toolUse" }),
    (request) => {
      seen = request.messages;
      return fauxAssistantMessage([fauxText("Done.")]);
    },
  ]);
  await (await conversation.submit({ type: "input", content: "hi" }, context)).wait(context);

  expect(toolResults(seen)).toEqual([
    { tool: "crash", text: expect.stringContaining("exited"), isError: true },
    { tool: "echo", text: expect.stringContaining("blocking execution"), isError: true },
  ]);
  expect(exits).toEqual([
    { message: expect.stringContaining("exited"), reopened: [], lost: [conversation.id] },
  ]);
  // The application goes on submitting: lost extensions run no `input` handlers.
  expect(await extensions.input("next")).toEqual({ action: "continue" });
});
