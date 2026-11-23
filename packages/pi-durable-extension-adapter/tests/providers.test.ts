import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { awaitWithContext, BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
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

async function setup({ maxWorkers = 1 } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-durable-extension-adapter-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const prepared = await prepareExtensions({
    sources: [path.join(import.meta.dirname, "fixtures", "provider.ts")],
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
      { models, registry, settings: { extensions: [app], retry: { enabled: false } } },
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

  return { models, attach };
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

test.each(["alone", "beside a conversation on another worker"])(
  "a conversation %s keeps its providers when its worker exits and is answered once they are back",
  async (where) => {
    const { attach, models } = await setup({ maxWorkers: 2 });
    const [anthropic] = models.getModels("anthropic");
    const alice = await attach("alice");
    const bob = where === "alone" ? undefined : await attach("bob");

    await expect(alice.extensions.input("exit")).rejects.toThrow("exited");
    expect(models.getModel("anthropic", anthropic.id)?.baseUrl).toBe("https://proxy.example");
    expect(await (await alice.ask("again")).wait(context)).toMatchObject({ status: "done" });
    expect(await alice.answer()).toMatchObject({ content: [{ text: "alice: again" }] });
    if (bob) {
      expect(await (await bob.ask("hello")).wait(context)).toMatchObject({ status: "done" });
      expect(await bob.answer()).toMatchObject({ content: [{ text: "bob: hello" }] });
    }
  },
);

test("a custom stream receives its caller's payload and response hooks", async () => {
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
  const stream = models.streamSimple(
    model,
    { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
    {
      sessionId: provider?.sessionId,
      onResponse: ({ status }) => {
        statuses.push(status);
      },
    },
  );
  expect(await stream.result()).toMatchObject({ content: [{ text: "alice: hello" }] });
  expect(statuses).toEqual([200]);
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
