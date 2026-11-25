import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import { awaitWithContext, BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { contentText } from "@earendil-works/pi-ai/utils/text";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createRegistry,
  defineExtension,
  defineTool,
  GenerationTask,
  Harness,
  hook,
  ProviderDoc,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { expect, onTestFinished, test } from "vite-plus/test";

import { startExtensionHost } from "../src/host.ts";
import { prepareExtensions } from "../src/prepare.ts";

// A built-in model API in the app, for providers registered with settings alone.
const echo = createFauxCore({ provider: "fixture", api: "host-echo" });
registerApiProvider(
  {
    api: "host-echo",
    stream: echo.stream,
    streamSimple: (model, transcript, options) => {
      const last = transcript.messages.at(-1);
      const text = last?.role === "user" ? contentText(last.content) : "";
      echo.setResponses([fauxAssistantMessage(`host ${model.baseUrl}: ${text}`)]);
      return echo.streamSimple(model, transcript, options);
    },
  },
  "providers-test",
);

async function setup({
  maxWorkers = 1,
  compaction,
  beside = [],
}: {
  maxWorkers?: number;
  compaction?: { keepRecentTokens: number };
  /** Fixtures that run beside the provider's. */
  beside?: readonly string[];
} = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-durable-extension-adapter-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const prepared = await prepareExtensions({
    sources: ["provider.ts", ...beside].map((name) =>
      path.join(import.meta.dirname, "fixtures", name),
    ),
    dir,
  });
  expect(prepared.failures).toEqual([]);
  const host = startExtensionHost({ prepared, maxWorkers });
  onTestFinished(() => host.close());
  const models = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });

  async function attach(name: string) {
    const registry = createRegistry();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string>();
    const app = defineExtension({
      name: "app",
      tools: [
        defineTool({
          name: "begin",
          description: "Begin collecting the receipt",
          parameters: { type: "object", properties: {} },
          execute: async () => ({}),
        }),
        defineTool({
          name: "stubborn",
          description: "Return the receipt, ignoring cancellation",
          parameters: { type: "object", properties: {} },
          async execute() {
            started.resolve();
            const text = await release.promise;
            return { output: [{ type: "text", text }] };
          },
        }),
        defineTool({
          name: "receipt",
          description: "Return the receipt",
          parameters: { type: "object", properties: {} },
          async execute(_args, _api, call) {
            started.resolve();
            const text = await awaitWithContext(release.promise, call);
            return { output: [{ type: "text", text }] };
          },
        }),
      ],
      hooks: [
        hook(GenerationTask, {
          beforeProviderRequest: async ({ payload }) => ({ payload: { app: true, from: payload } }),
        }),
      ],
    });
    registry.install(app);
    const harness = await Harness.open(
      new MemoryStorage(),
      {
        models,
        registry,
        settings: {
          extensions: [app],
          retry: { enabled: false },
          ...(compaction && { compaction }),
        },
      },
      context,
    );
    onTestFinished(() => harness.close(context));
    const conversation = await harness.root(context, {
      agent: { model: { provider: "fixture", modelId: "echo" } },
    });
    const extensions = await host.attach(
      { harness, conversation, registry, models, cwd: path.join(dir, name) },
      context,
    );
    onTestFinished(() => extensions.close());
    // A failing test must not leave a tool waiting, which would hold up closing the Harness.
    onTestFinished(() => release.resolve("finished"));
    expect(extensions.errors).toEqual([]);
    const ask = (content: string) => conversation.submit({ type: "input", content }, context);
    const answer = async () => (await conversation.context(context)).messages.at(-1);
    return {
      ask,
      answer,
      harness,
      conversation,
      extensions,
      started: started.promise,
      release: release.resolve,
    };
  }

  return { models, attach, dir };
}

test.each(["while the provider is streaming", "while its second tool is running"])(
  "aborting one conversation %s releases its provider and leaves its neighbour running",
  async (when) => {
    const { attach } = await setup();
    const alice = await attach("alice");
    const bob = await attach("bob");
    const active = when === "while the provider is streaming";
    const first = await alice.ask(active ? "wait for provider" : "call two tools");
    const second = await bob.ask("call tool");
    await bob.started;
    if (!active) await alice.started;
    const status = () => alice.extensions.input("status");
    await expect.poll(status).toMatchObject({ action: "transform", text: "open" });

    await alice.conversation.abort(context);
    expect(await first.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
    await expect.poll(status).toMatchObject({ action: "transform", text: "aborted" });
    expect(await (await alice.ask("again")).wait(context)).toMatchObject({ status: "done" });
    expect(await alice.answer()).toMatchObject({ content: [{ text: "alice: again" }] });
    await alice.extensions.close();

    const receipt = randomUUID();
    bob.release(receipt);
    expect(await second.wait(context)).toMatchObject({ status: "done" });
    expect(await bob.answer()).toMatchObject({ content: [{ text: `bob: ${receipt}` }] });
  },
);

test("aborting a conversation while a tool that ignores the abort runs stops its provider's query", async () => {
  const { attach } = await setup();
  const alice = await attach("alice");
  const submission = await alice.ask("call stubborn tool");
  await alice.started;
  const status = () => alice.extensions.input("status");
  expect(await status()).toMatchObject({ action: "transform", text: "open" });

  const aborting = alice.conversation.abort(context);
  await expect.poll(status).toMatchObject({ action: "transform", text: "aborted" });
  alice.release("late");
  await aborting;
  expect(await submission.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
});

test("aborting a run whose provider answers with a tool call after the abort releases its query", async () => {
  const { attach } = await setup();
  const alice = await attach("alice");
  const submission = await alice.ask("ignore abort");
  const status = () => alice.extensions.input("status");
  await expect.poll(status).toMatchObject({ action: "transform", text: "open" });

  await alice.conversation.abort(context);
  expect(await submission.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
  expect(await status()).toMatchObject({ action: "transform", text: "aborted" });
  expect(await (await alice.ask("again")).wait(context)).toMatchObject({ status: "done" });
});

test("a direct caller's abort stops a provider query that asked for tools", async () => {
  const { attach, models } = await setup();
  const alice = await attach("alice");
  const model = models.getModel("fixture", "echo");
  if (!model) throw new Error("The fixture's model is missing");
  const provider = await alice.harness.snapshot(ProviderDoc, alice.conversation.id, context);
  const caller = new AbortController();
  const stream = models.streamSimple(
    model,
    { messages: [{ role: "user", content: "call tool", timestamp: Date.now() }] },
    { sessionId: provider?.sessionId, signal: caller.signal },
  );
  expect(await stream.result()).toMatchObject({ stopReason: "toolUse" });
  const status = () => alice.extensions.input("status");
  expect(await status()).toMatchObject({ action: "transform", text: "open" });

  caller.abort();
  await expect.poll(status).toMatchObject({ action: "transform", text: "aborted" });
});

test("a conversation's next requests, a direct caller's too, wait for its session_compact handlers", async () => {
  const { attach, models, dir } = await setup({
    compaction: { keepRecentTokens: 1 },
    beside: ["compact-hold.ts"],
  });
  const alice = await attach("alice");
  expect(await (await alice.ask("one")).wait(context)).toMatchObject({ status: "done" });
  expect(await (await alice.ask("two")).wait(context)).toMatchObject({ status: "done" });
  const hold = path.join(dir, "alice.compact");
  await writeFile(hold, "");
  onTestFinished(() => rm(hold, { force: true }));
  // Idle, so the summary is placed at once, and its handler holds.
  const compaction = await alice.conversation.compact(undefined, context);
  await alice.harness.waitForTask(compaction, context);
  const model = models.getModel("fixture", "echo");
  if (!model) throw new Error("The fixture's model is missing");
  const provider = await alice.harness.snapshot(ProviderDoc, alice.conversation.id, context);
  const direct = models
    .streamSimple(
      model,
      { messages: [{ role: "user", content: "direct", timestamp: Date.now() }] },
      { sessionId: provider?.sessionId },
    )
    .result();
  const asked = (await alice.ask("three")).wait(context);

  const answered = Promise.race([direct, asked]).then(() => "answered");
  expect(await Promise.race([answered, setTimeout(300, "waiting")])).toBe("waiting");
  await rm(hold);
  expect(await direct).toMatchObject({ stopReason: "stop" });
  expect(await asked).toMatchObject({ status: "done" });
});

test.each(["with", "without"])(
  "closing a conversation ends the provider query of a direct caller %s a signal while a shutdown handler hangs",
  async (given) => {
    const { attach, models, dir } = await setup();
    const alice = await attach("alice");
    const bob = await attach("bob");
    const model = models.getModel("fixture", "echo");
    if (!model) throw new Error("The fixture's model is missing");
    const provider = await alice.harness.snapshot(ProviderDoc, alice.conversation.id, context);
    const stream = models.streamSimple(
      model,
      { messages: [{ role: "user", content: "call tool", timestamp: Date.now() }] },
      {
        sessionId: provider?.sessionId,
        ...(given === "with" && { signal: new AbortController().signal }),
      },
    );
    expect(await stream.result()).toMatchObject({ stopReason: "toolUse" });
    const status = () => bob.extensions.input("status of alice");
    expect(await status()).toMatchObject({ action: "transform", text: "open" });

    const hold = path.join(dir, "alice.shutdown");
    await writeFile(hold, "");
    onTestFinished(() => rm(hold, { force: true }));
    const closing = alice.extensions.close();
    await expect.poll(status).toMatchObject({ action: "transform", text: "aborted" });
    await rm(hold);
    await closing;
  },
);

test.each(["alone", "beside a conversation on another worker"])(
  "a conversation %s has its extensions' models again once their worker's replacement registers them",
  async (where) => {
    const { attach, models, dir } = await setup({ maxWorkers: 2 });
    const [anthropic] = models.getModels("anthropic");
    const alice = await attach("alice");
    const bob = where === "alone" ? undefined : await attach("bob");
    const hold = path.join(dir, "alice.hold");
    await writeFile(hold, "");
    onTestFinished(() => rm(hold, { force: true }));

    expect(await (await alice.ask("crash")).wait(context)).toMatchObject({
      status: "unanswered",
      reason: "model_error",
      detail: expect.stringContaining("exited with code 3"),
    });
    // The reopening waits in `session_start`, before the extensions register their stream.
    expect(await (await alice.ask("meanwhile")).wait(context)).toMatchObject(
      bob
        ? { status: "unanswered", reason: "model_error" }
        : { status: "unanswered", reason: "no_model" },
    );
    if (bob) {
      expect(await (await bob.ask("hello")).wait(context)).toMatchObject({ status: "done" });
      expect(await bob.answer()).toMatchObject({ content: [{ text: "bob: hello" }] });
    }

    await rm(hold);
    // Waits for the extensions to open again.
    await alice.extensions.input("status");
    expect(await (await alice.ask("again")).wait(context)).toMatchObject({ status: "done" });
    expect(await alice.answer()).toMatchObject({ content: [{ text: "alice: again" }] });
    expect(models.getModel("anthropic", anthropic.id)?.baseUrl).toBe("https://proxy.example");
    if (bob) {
      expect(await (await bob.ask("again")).wait(context)).toMatchObject({ status: "done" });
      expect(await bob.answer()).toMatchObject({ content: [{ text: "bob: again" }] });
    }
  },
);

test("after a worker exit, a provider whose stream a handler added has it again once the handler runs", async () => {
  const { attach } = await setup();
  const carol = await attach("carol");
  await carol.extensions.input("register late");
  await carol.conversation.configure({ model: { provider: "late", modelId: "echo" } }, context);
  expect(await (await carol.ask("hello")).wait(context)).toMatchObject({ status: "done" });

  await expect(carol.extensions.input("exit")).rejects.toThrow("exited");
  // Waits for the extensions to open again, which register the provider's settings alone.
  await carol.extensions.input("status");
  expect(await (await carol.ask("again")).wait(context)).toMatchObject({
    status: "unanswered",
    reason: "model_error",
  });
  await carol.extensions.input("register late");
  expect(await (await carol.ask("again")).wait(context)).toMatchObject({ status: "done" });
  expect(await carol.answer()).toMatchObject({ content: [{ text: "carol: again" }] });
});

test("a custom stream receives its caller's payload, response and stream event hooks", async () => {
  const { attach, models } = await setup();
  const alice = await attach("alice");
  expect(await (await alice.ask("payload")).wait(context)).toMatchObject({ status: "done" });
  expect(await alice.answer()).toMatchObject({
    content: [{ text: JSON.stringify({ app: true, from: { owner: "alice" } }) }],
  });

  // pi-durable passes only `onPayload`; an app that calls the runtime itself can pass the others.
  const model = models.getModel("fixture", "echo");
  if (!model) throw new Error("The fixture's model is missing");
  const provider = await alice.harness.snapshot(ProviderDoc, alice.conversation.id, context);
  const statuses: number[] = [];
  const streamed: unknown[] = [];
  const stream = models.streamSimple(
    model,
    { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
    {
      sessionId: provider?.sessionId,
      onResponse: ({ status }) => {
        statuses.push(status);
      },
      onProviderStreamEvent: (data) => {
        streamed.push(data);
      },
    },
  );
  expect(await stream.result()).toMatchObject({ content: [{ text: "alice: hello" }] });
  expect(statuses).toEqual([200]);
  expect(streamed).toEqual([{ owner: "alice" }]);
});

test("a shared catalog can gain models while each conversation keeps its own provider", async () => {
  const { attach, models } = await setup();
  models.registerProvider("anthropic", { baseUrl: "https://app.example" });
  const [prior] = models.getModels("anthropic");
  const alice = await attach("alice");
  const bob = await attach("bob");
  await alice.extensions.input("refresh");
  const model = { provider: "fixture", modelId: "new" };
  expect(models.getModel(model.provider, model.modelId)).toBeDefined();
  await bob.conversation.configure({ model }, context);
  expect(await (await bob.ask("hello")).wait(context)).toMatchObject({ status: "done" });
  expect(await bob.answer()).toMatchObject({ content: [{ text: "bob: hello" }] });

  await alice.extensions.input("change endpoint");
  expect(await (await bob.ask("endpoint")).wait(context)).toMatchObject({ status: "done" });
  expect(await bob.answer()).toMatchObject({ content: [{ text: "https://other.example" }] });

  await bob.extensions.close();
  expect(models.getModel("anthropic", prior.id)?.baseUrl).toBe("https://proxy.example");
  await alice.extensions.input("add headers");
  expect(await alice.extensions.input("invalid stream")).toMatchObject({
    action: "transform",
    text: expect.stringContaining('"api" is required'),
  });
  expect(await (await alice.ask("header")).wait(context)).toMatchObject({ status: "done" });
  expect(await alice.answer()).toMatchObject({ content: [{ text: "updated" }] });
  await alice.extensions.close();
  expect(models.getModel("anthropic", prior.id)?.baseUrl).toBe(prior.baseUrl);
  expect(models.getModel("fixture", "echo")).toBeUndefined();
});

test("a conversation that registered settings alone is served by Pi once the last custom stream's conversation closes", async () => {
  const { attach } = await setup({ maxWorkers: 2 });
  const alice = await attach("alice");
  const dave = await attach("dave");
  expect(await (await dave.ask("hello")).wait(context)).toMatchObject({
    status: "unanswered",
    reason: "model_error",
  });

  await alice.extensions.close();
  expect(await (await dave.ask("hello")).wait(context)).toMatchObject({ status: "done" });
  expect(await dave.answer()).toMatchObject({
    content: [{ text: "host https://dave.example: hello" }],
  });
});
