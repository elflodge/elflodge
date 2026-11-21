import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { awaitWithContext, BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { expect, onTestFinished, test } from "vite-plus/test";

import { startExtensionHost } from "../src/host.ts";
import { prepareExtensions } from "../src/prepare.ts";

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-durable-extension-adapter-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const prepared = await prepareExtensions({
    sources: [path.join(import.meta.dirname, "fixtures", "provider.ts")],
    dir,
  });
  expect(prepared.failures).toEqual([]);
  const host = startExtensionHost({ prepared, maxWorkers: 1 });
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
    expect(extensions.errors).toEqual([]);
    const ask = (content: string) => conversation.submit({ type: "input", content }, context);
    const answer = async () => (await conversation.context(context)).messages.at(-1);
    return {
      ask,
      answer,
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
    expect(await bob.answer()).toMatchObject({ content: [{ text: receipt }] });
  },
);

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
