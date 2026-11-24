import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { it } from "@effect/vitest";
import {
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  JOB_FAILED,
  JOB_SUCCEEDED,
  jobReportSchema,
  registeredRunnerSchema,
  runnerRequests,
} from "contract";
import { ConfigProvider, Deferred, Effect, Layer, Stdio } from "effect";
import { assert, expect, onTestFinished, vi } from "vite-plus/test";
import { WebSocketServer } from "ws";
import * as z from "zod/mini";

import { runnerCli } from "../src/main.ts";
import { acquireJobModels } from "../src/models.ts";

// Which server each job's model requests reach, from a Runner started as `elflodge stack` starts
// it, with the extension in `fixtures/provider-extensions`, which points Groq at a proxy of its own
// for each job. Every server is a stand-in on this host, and any other address is refused.

const PROVIDER = "groq";
const MODEL = "llama-3.1-8b-instant";

/** What a stand-in model server received: the path, the job's input it carried, and its key. */
interface ModelRequest {
  path: string;
  input: string;
  authorization: string | undefined;
}

/** One Server-Sent Event of a Chat Completions stream. */
const chunk = (choice: object, extra: object = {}) =>
  `data: ${JSON.stringify({ id: "answer", object: "chat.completion.chunk", created: 0, model: MODEL, choices: [{ index: 0, ...choice }], ...extra })}\n\n`;

/** A Server-Sent Events body of one Chat Completions answer calling `submit_output` with `args`. */
function callSubmitOutput(args: object) {
  return (
    chunk({
      delta: {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: randomUUID(),
            type: "function",
            function: { name: "submit_output", arguments: JSON.stringify(args) },
          },
        ],
      },
      finish_reason: null,
    }) +
    chunk(
      { delta: {}, finish_reason: "tool_calls" },
      { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ) +
    "data: [DONE]\n\n"
  );
}

/** The URL of a server listening on this host. */
function urlOf(server: { address(): AddressInfo | string | null }) {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Not listening on a port");
  return `http://127.0.0.1:${address.port}`;
}

const ChatRequest = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.optional(z.unknown()) })),
});

/**
 * A stand-in for the model's API at every path. A job's first request is answered once `jobs`
 * jobs have each made theirs, so every job's extensions are attached before any job's second
 * request; it calls `submit_output` with nothing, which the tool refuses, and the second request
 * submits an output.
 */
const standInModel = (jobs: number) =>
  Effect.promise(async () => {
    const requests: ModelRequest[] = [];
    const allAsked = Promise.withResolvers<void>();
    const firsts = new Set<string>();
    const server = createServer(async (request: IncomingMessage, response) => {
      const body = ChatRequest.parse(JSON.parse(await new Response(request).text()));
      const user = body.messages.find((message) => message.role === "user");
      const input =
        typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
      requests.push({
        path: request.url ?? "",
        input,
        authorization: request.headers.authorization,
      });
      const answered = body.messages.some((message) => message.role === "tool");
      if (!answered) {
        firsts.add(input);
        if (firsts.size === jobs) allAsked.resolve();
        await allAsked.promise;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(callSubmitOutput(answered ? { value: {} } : {}));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    onTestFinished(() => {
      server.close();
    });
    return { url: urlOf(server), requests };
  });

/** A job the stand-in hub places, with its own input and instructions, so none waits on another. */
const job = (input: string) => ({
  jobId: randomUUID(),
  runId: randomUUID(),
  intent: "run" as const,
  position: 0,
  job: { instructions: input, input, files: [], outputContract: { schema: {} } },
  runTimeoutSeconds: 120,
  modelBudgetUsd: 1,
});

/**
 * A stand-in hub placing `runs` on the Runner until each has ended; `ended` completes with how
 * each job ended, by its ID.
 */
const standInHub = (runs: ReturnType<typeof job>[]) =>
  Effect.gen(function* () {
    const ended = yield* Deferred.make<Map<string, string>>();
    const ends = new Map<string, string>();
    const hub = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    yield* Effect.promise(() => once(hub, "listening"));
    onTestFinished(() => {
      hub.close();
    });
    const open = () => runs.filter((run) => !ends.has(run.jobId));
    hub.on("connection", (socket) => {
      socket.addEventListener("message", ({ data: text }) => {
        assert(typeof text === "string", "the Runner sent a binary message");
        if (text === HEARTBEAT_PING) return socket.send(HEARTBEAT_PONG);
        const request = z.parse(
          z.object({ id: z.number(), method: z.string(), params: z.unknown() }),
          JSON.parse(text),
        );
        const reply = (result: unknown) =>
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
        if (request.method === "hello") return reply({ syncIntervalMs: 200, reportIntervalMs: 50 });
        if (request.method === "sync") return reply({ runs: open(), deletions: [] });
        if (request.method !== "report") return;
        for (const report of z.parse(runnerRequests.report.params, request.params).jobs) {
          for (const event of z.parse(jobReportSchema, report).events) {
            if (
              event.type === "entry" &&
              (event.record.kind === JOB_SUCCEEDED || event.record.kind === JOB_FAILED)
            ) {
              ends.set(report.jobId, event.record.kind);
            }
          }
        }
        reply({ runs: open(), deletions: [], refused: [] });
        if (ends.size === runs.length) Deferred.doneUnsafe(ended, Effect.succeed(ends));
      });
    });
    return { url: urlOf(hub), ended: Deferred.await(ended) };
  });

/** Runs a Runner with `env` and a Groq API key saved by `login`, until the test ends. */
const startRunner = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const dataDir = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "runner-models-")));
    onTestFinished(() => rm(dataDir, { recursive: true, force: true }));
    yield* Effect.promise(async () => {
      await writeFile(
        path.join(dataDir, "runner.json"),
        JSON.stringify(z.parse(registeredRunnerSchema, { id: "runner", key: "key" })),
      );
      await writeFile(
        path.join(dataDir, "auth.json"),
        JSON.stringify({ [PROVIDER]: { type: "api_key", key: "fake-key" } }),
      );
    });
    yield* runnerCli.pipe(
      Effect.provide(
        Layer.mergeAll(
          Stdio.layerTest({ args: Effect.succeed([]) }),
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                RUNNER_REGISTRATION_KEY: "unused",
                RUNNER_DATA_DIR: dataDir,
                RUNNER_MODEL_PROVIDER: PROVIDER,
                RUNNER_MODEL_ID: MODEL,
                RUNNER_MAX_JOBS: "2",
                RUNNER_RUN_WITHOUT_SANDBOX: "true",
                RUNNER_EXTENSIONS_DIR: path.join(
                  import.meta.dirname,
                  "fixtures",
                  "provider-extensions",
                ),
                ...env,
              },
            }),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  });

/** Refuses every request the Runner's process makes to an address other than this host. */
function refuseOtherHosts() {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) => {
    const [input] = args;
    const url = new URL(input instanceof Request ? input.url : input);
    return url.hostname === "127.0.0.1"
      ? realFetch(...args)
      : Promise.reject(new Error(`The test refuses requests to ${url.host}`));
  });
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
}

it.live(
  "each job's model requests go where its own extensions point its provider",
  () =>
    Effect.gen(function* () {
      refuseOtherHosts();
      const model = yield* standInModel(2);
      vi.stubEnv("PROXY_URL", model.url);
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      const alpha = job("alpha");
      const beta = job("beta");
      const hub = yield* standInHub([alpha, beta]);
      yield* startRunner({ HUB_URL: hub.url });

      const ended = yield* hub.ended;

      expect(ended.get(alpha.jobId)).toBe(JOB_SUCCEEDED);
      expect(ended.get(beta.jobId)).toBe(JOB_SUCCEEDED);
      // Each job asks twice, its second request after both jobs' extensions have registered.
      for (const { jobId, job: content } of [alpha, beta]) {
        const own = model.requests.filter((request) => request.input === content.input);
        expect(own.map((request) => request.path)).toEqual([
          `/${jobId}/v1/chat/completions`,
          `/${jobId}/v1/chat/completions`,
        ]);
      }
      expect(new Set(model.requests.map((request) => request.authorization))).toEqual(
        new Set(["Bearer fake-key"]),
      );
    }),
  60_000,
);

it.live(
  "with RUNNER_MODEL_BASE_URL, every job's model requests go there, whatever its extensions register",
  () =>
    Effect.gen(function* () {
      refuseOtherHosts();
      const model = yield* standInModel(1);
      vi.stubEnv("PROXY_URL", model.url);
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      const alpha = job("alpha");
      const hub = yield* standInHub([alpha]);
      yield* startRunner({ HUB_URL: hub.url, RUNNER_MODEL_BASE_URL: `${model.url}/base/v1` });

      const ended = yield* hub.ended;

      expect(ended.get(alpha.jobId)).toBe(JOB_SUCCEEDED);
      expect(model.requests.map((request) => request.path)).toEqual([
        "/base/v1/chat/completions",
        "/base/v1/chat/completions",
      ]);
    }),
  60_000,
);

it.live("with a model URL, a sign-in saved while a job runs never reaches it", () =>
  Effect.gen(function* () {
    vi.stubEnv("OPENAI_API_KEY", undefined);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const credentials = new InMemoryCredentialStore();
    yield* Effect.promise(() =>
      credentials.modify("openai", async () => ({ type: "api_key", key: "fake-key" })),
    );
    const models = yield* acquireJobModels(credentials, {
      provider: "openai",
      baseUrl: new URL("http://127.0.0.1:4000/v1"),
    });
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
