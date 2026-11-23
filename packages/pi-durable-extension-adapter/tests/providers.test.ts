import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { awaitWithContext, BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { InMemoryCredentialStore, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
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
import { afterAll, beforeAll, describe, expect, onTestFinished, test } from "vite-plus/test";

import { startExtensionHost, type AttachedExtensions, type ExtensionHost } from "../src/host.ts";
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

test("after a worker exit, a provider only the old instance registered goes until registered again", async () => {
  const { attach } = await setup();
  const alice = await attach("alice");
  await alice.extensions.input("register late");
  await alice.conversation.configure({ model: { provider: "late", modelId: "echo" } }, context);
  expect(await (await alice.ask("hello")).wait(context)).toMatchObject({ status: "done" });

  await expect(alice.extensions.input("exit")).rejects.toThrow("exited");
  // Waits for the extensions to open again.
  await alice.extensions.input("status");
  expect(await (await alice.ask("again")).wait(context)).toMatchObject({
    status: "unanswered",
    reason: "no_model",
  });
  await alice.extensions.input("register late");
  expect(await (await alice.ask("again")).wait(context)).toMatchObject({ status: "done" });
  expect(await alice.answer()).toMatchObject({ content: [{ text: "alice: again" }] });
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
    expect(models.getModel("anthropic", anthropic.id)?.baseUrl).toBe("https://proxy.example");
    if (bob) {
      expect(await (await bob.ask("hello")).wait(context)).toMatchObject({ status: "done" });
      expect(await bob.answer()).toMatchObject({ content: [{ text: "bob: hello" }] });
    }
  },
);

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

// What a worker's exit and the reopening of a conversation's extensions leave must equal closing
// that attachment and attaching it again, as after a restart, with the same peer and app.
const dimensions = {
  first: ["nothing", "settings", "custom", "settings-then-custom"],
  next: ["nothing", "settings", "settings-if-absent", "custom", "custom-if-absent"],
  peer: ["none", "settings", "custom"],
  app: ["nothing", "config", "native"],
} as const;
type Combination = { [K in keyof typeof dimensions]: (typeof dimensions)[K][number] };

function product(): Combination[] {
  const { first, next, peer, app } = dimensions;
  return first.flatMap((f) =>
    next.flatMap((n) =>
      peer.flatMap((p) => app.map((a) => ({ first: f, next: n, peer: p, app: a }))),
    ),
  );
}

/** Combinations that together contain every pair of values of two dimensions, starting with `seed`. */
function pairwise(all: Combination[], seed: Combination[]) {
  const keys = ["first", "next", "peer", "app"] satisfies (keyof Combination)[];
  const pairs = (each: Combination) =>
    keys.flatMap((a, i) => keys.slice(i + 1).map((b) => `${a}=${each[a]},${b}=${each[b]}`));
  const missing = new Set(all.flatMap(pairs));
  const chosen: Combination[] = [];
  const take = (each: Combination) => {
    chosen.push(each);
    for (const pair of pairs(each)) missing.delete(pair);
  };
  seed.forEach(take);
  while (missing.size > 0) {
    const gain = (each: Combination) => pairs(each).filter((pair) => missing.has(pair)).length;
    take(all.reduce((best, each) => (gain(each) > gain(best) ? each : best)));
  }
  return chosen;
}

const reported: Combination[] = [
  // An extension that registers its provider in `session_start` when it finds none.
  { first: "settings", next: "settings-if-absent", peer: "none", app: "nothing" },
  // Settings first, a custom stream later from a handler, and the settings again on reopening.
  { first: "settings-then-custom", next: "settings", peer: "none", app: "nothing" },
];
// The whole product takes about 30 s and slows the other test files running beside it into their
// time limits, so the suite runs a subset with every pair of values; LIFETIME_MATRIX=all runs all.
const combinations =
  process.env.LIFETIME_MATRIX === "all" ? product() : pairwise(product(), reported);

const lastText = (transcript: TranscriptContext) => {
  const last = transcript.messages.at(-1);
  return last?.role === "user" ? contentText(last.content) : "";
};
const answering =
  (label: string): FauxResponseFactory =>
  (transcript, _options, _state, model) =>
    fauxAssistantMessage(`${label} ${model.baseUrl}: ${lastText(transcript)}`);
let host: ExtensionHost;
let dir: string;

async function runtime(app: Combination["app"]) {
  const models = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const appModels = [{ id: "echo" }, { id: "app" }];
  if (app === "config")
    models.registerProvider("shared", {
      api: "host-echo",
      baseUrl: "https://app.example",
      apiKey: "unused",
      models: appModels.map((model) => ({
        ...model,
        name: model.id,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 100,
      })),
    });
  if (app === "native") {
    const native = fauxProvider({ provider: "shared", api: "native-echo", models: appModels });
    models.registerNativeProvider({
      ...native.provider,
      streamSimple: (model: Model<string>, transcript, options) => {
        native.setResponses([answering("native")]);
        return native.provider.streamSimple(model, transcript, options);
      },
    });
  }
  return models;
}

/** The fixture's report of what an instance registered, and what it read before. */
async function input(extensions: AttachedExtensions, text: string) {
  const result = await extensions.input(text);
  const report: unknown = JSON.parse(result.action === "transform" ? result.text : "null");
  return report;
}

type Arrangement = {
  plan: string;
  peer: Combination["peer"];
  app: Combination["app"];
  asks?: number;
};

/** Attaches a conversation with the extension acting on `plan`, on a Harness of its own. */
async function open(models: ModelRuntime, plan: string, owner: string) {
  const registry = createRegistry();
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, settings: { extensions: [], retry: { enabled: false } } },
    context,
  );
  onTestFinished(() => harness.close(context));
  const conversation = await harness.root(context, {
    agent: { model: { provider: "shared", modelId: "echo" } },
  });
  const options = { harness, conversation, registry, models, cwd: path.join(dir, plan, owner) };
  const extensions = await host.attach(options, context);
  onTestFinished(() => extensions.close());
  expect(extensions.errors).toEqual([]);
  const ask = async () => {
    const result = await (
      await conversation.submit({ type: "input", content: "hello" }, context)
    ).wait(context);
    if (result.status !== "done") return result.reason;
    const last = (await conversation.context(context)).messages.at(-1);
    return last?.role === "assistant" ? contentText(last.content) : last?.role;
  };
  return { options, extensions, ask };
}

async function scenario(arrangement: Arrangement, restart: "worker exit" | "close and attach") {
  const models = await runtime(arrangement.app);
  const peer =
    arrangement.peer === "none" ? undefined : await open(models, `peer-${arrangement.peer}`, "bob");
  if (peer) expect(await input(peer.extensions, "first")).toEqual({});
  const alice = await open(models, arrangement.plan, "alice");
  const first = await input(alice.extensions, "first");

  let extensions = alice.extensions;
  if (restart === "worker exit") {
    await expect(extensions.input("exit")).rejects.toThrow("exited");
  } else {
    await extensions.close();
    extensions = await host.attach(alice.options, context);
    onTestFinished(() => extensions.close());
    expect(extensions.errors).toEqual([]);
  }
  // Waits for the reopening.
  const next = await input(extensions, "report");
  const config = models.getRegisteredProviderConfig("shared");
  const outcome = {
    first,
    next,
    runtime: {
      stream: config?.streamSimple !== undefined,
      native: models.getRegisteredNativeProvider("shared") !== undefined,
      baseUrl: models.getProvider("shared")?.baseUrl,
      models: models
        .getModels("shared")
        .map((model) => model.id)
        .toSorted(),
    },
    alice: await alice.ask(),
    ...(arrangement.asks === 2 && { again: await alice.ask() }),
    bob: await peer?.ask(),
  };
  // The next scenario starts on workers without these conversations.
  await extensions.close();
  await peer?.extensions.close();
  return outcome;
}

describe("provider registrations through a worker exit", () => {
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pi-durable-extension-adapter-"));
    const prepared = await prepareExtensions({
      sources: [path.join(import.meta.dirname, "fixtures", "lifetime.ts")],
      dir,
    });
    expect(prepared.failures).toEqual([]);
    host = startExtensionHost({ prepared, maxWorkers: 2 });
    // The API a provider registered with settings alone uses, which runs in the app.
    const core = createFauxCore({ provider: "shared", api: "host-echo", models: [{ id: "echo" }] });
    registerApiProvider(
      {
        api: "host-echo",
        stream: core.stream,
        streamSimple: (model, transcript, options) => {
          core.setResponses([answering("host")]);
          return core.streamSimple(model, transcript, options);
        },
      },
      "lifetime-test",
    );
  });

  afterAll(async () => {
    await host?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test.each(combinations.map((each) => [Object.values(each).join(" / "), each] as const))(
    "a worker exit leaves providers as closing and attaching again does: %s",
    async (_name, combination) => {
      const arrangement = { ...combination, plan: `${combination.first}~${combination.next}` };
      const closed = await scenario(arrangement, "close and attach");
      const exited = await scenario(arrangement, "worker exit");
      expect(exited).toEqual(closed);
      // The register guard refuses a custom stream beside a peer that uses the built-in one.
      const refused = combination.peer === "settings" && combination.first.includes("custom");
      expect(closed.first).toEqual(refused ? { error: expect.any(String) } : {});
    },
  );

  test("an extension that registers its provider's settings after every message keeps it through a worker exit", async () => {
    const arrangement = { plan: "every-message", peer: "none", app: "nothing", asks: 2 } as const;
    const closed = await scenario(arrangement, "close and attach");
    expect(closed).toMatchObject({
      alice: "host https://alice-1.example: hello",
      again: "host https://alice-1.example: hello",
    });
    expect(await scenario(arrangement, "worker exit")).toEqual(closed);
  });

  test("a conversation that registered settings alone is served by Pi once the last custom stream's conversation closes", async () => {
    const models = await runtime("nothing");
    const alice = await open(models, "custom~nothing", "alice");
    expect(await input(alice.extensions, "first")).toEqual({});
    const bob = await open(models, "peer-settings", "bob");
    expect(await input(bob.extensions, "first")).toEqual({});
    expect(await bob.ask()).toBe("model_error");

    await alice.extensions.close();
    expect(await bob.ask()).toBe("host https://bob-1.example: hello");
  });
});
