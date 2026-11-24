import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { it } from "@effect/vitest";
import {
  type ExtensionHost,
  prepareExtensions,
  startExtensionHost,
} from "@elflodge/pi-durable-extension-adapter";
import { Effect } from "effect";
import { afterAll, beforeAll, expect, onTestFinished, vi } from "vite-plus/test";

import { acquireJobModels } from "../src/auth.ts";

// What each job's models are made with, as `openJob` uses them: the job's Pi extensions are attached
// with the models its Harness was opened with. The extension points OpenAI at a server of its own,
// as a proxy extension would.

const EXTENSION_URL = "http://127.0.0.1:9/extension";

let dir: string;
let host: ExtensionHost;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "runner-job-models-"));
  const source = path.join(dir, "proxy.ts");
  await writeFile(
    source,
    `export default function (pi) { pi.registerProvider("openai", { baseUrl: "${EXTENSION_URL}" }); }`,
  );
  const prepared = await prepareExtensions({ sources: [source], dir: path.join(dir, "prepared") });
  expect(prepared.failures).toEqual([]);
  host = startExtensionHost({ prepared, maxWorkers: 1 });
}, 60_000);

afterAll(async () => {
  await host?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** Opens a job's journal with `models` and attaches its extensions, as `openJob` does. */
async function attachExtensions(models: ModelRuntime) {
  const registry = createRegistry();
  const app = defineExtension({ name: "app" });
  registry.install(app);
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, settings: { extensions: [app] } },
    context,
  );
  onTestFinished(() => harness.close(context));
  const conversation = await harness.root(context, {
    agent: { model: { provider: "openai", modelId: "gpt-5.2" } },
  });
  const extensions = await host.attach(
    { harness, conversation, registry, models, cwd: dir },
    context,
  );
  onTestFinished(() => extensions.close());
  return extensions;
}

const openaiUrl = (models: ModelRuntime) => models.getModel("openai", "gpt-5.2")?.baseUrl;

it.live("an extension's provider settings reach only its own job's models", () =>
  Effect.gen(function* () {
    const credentials = new InMemoryCredentialStore();
    const first = yield* acquireJobModels(credentials, { provider: "openai" });
    const second = yield* acquireJobModels(credentials, { provider: "openai" });
    const piUrl = openaiUrl(second);

    const extensions = yield* Effect.promise(() => attachExtensions(first));

    expect(extensions.errors).toEqual([]);
    expect(openaiUrl(first)).toBe(EXTENSION_URL);
    expect(openaiUrl(second)).toBe(piUrl);
    expect(piUrl).not.toBe(EXTENSION_URL);
  }),
);

it.live(
  "a job's models call the provider at the model URL with its API key, whatever extensions or a later sign-in do",
  () =>
    Effect.gen(function* () {
      vi.stubEnv("OPENAI_API_KEY", undefined);
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      const credentials = new InMemoryCredentialStore();
      yield* Effect.promise(() =>
        credentials.modify("openai", async () => ({ type: "api_key", key: "fake-key" })),
      );
      const baseUrl = new URL("http://127.0.0.1:4000/v1");
      const models = yield* acquireJobModels(credentials, { provider: "openai", baseUrl });
      expect(openaiUrl(models)).toBe(baseUrl.href);
      expect((yield* Effect.promise(() => models.getAuth("openai")))?.auth.apiKey).toBe("fake-key");

      const extensions = yield* Effect.promise(() => attachExtensions(models));
      expect(extensions.errors).toEqual([
        expect.objectContaining({ message: expect.stringContaining("native provider") }),
      ]);
      expect(openaiUrl(models)).toBe(baseUrl.href);

      // A sign-in `login` saves while the job runs.
      yield* Effect.promise(() =>
        credentials.modify("openai", async () => ({
          type: "oauth",
          access: "fake-access",
          refresh: "fake-refresh",
          expires: Date.now() + 3_600_000,
        })),
      );
      expect(yield* Effect.promise(() => models.getAuth("openai"))).toBeUndefined();
    }),
);
