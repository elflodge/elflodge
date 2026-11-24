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
  createJsonRpcServer,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  JOB_FAILED,
  JOB_SUCCEEDED,
  jobReportSchema,
  registeredRunnerSchema,
  runnerRequests,
} from "contract";
import { ConfigProvider, Deferred, Effect, Fiber, Layer, Stdio } from "effect";
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
  Effect.gen(function* () {
    const failed = yield* Deferred.make<never, Error>();
    const { url, requests } = yield* Effect.promise(() => serveModel(jobs, failed));
    return { url, requests, failed: Deferred.await(failed) };
  });

async function serveModel(jobs: number, failed: Deferred.Deferred<never, Error>) {
  const requests: ModelRequest[] = [];
  const allAsked = Promise.withResolvers<void>();
  const firsts = new Set<string>();
  const server = createServer(async (request: IncomingMessage, response) => {
    const body = ChatRequest.parse(JSON.parse(await new Response(request).text()));
    const user = body.messages.find((message) => message.role === "user");
    const input = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
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
  server.on("error", (error) => Deferred.doneUnsafe(failed, Effect.fail(error)));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  onTestFinished(() => {
    server.close();
  });
  return { url: urlOf(server), requests };
}

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
    const failed = yield* Deferred.make<never, Error>();
    const fail = (error: Error) => Deferred.doneUnsafe(failed, Effect.fail(error));
    const ends = new Map<string, string>();
    const open = () => runs.filter((run) => !ends.has(run.jobId));
    const answer = createJsonRpcServer(runnerRequests, {
      hello: async () => ({ syncIntervalMs: 200, reportIntervalMs: 50 }),
      sync: async () => ({ runs: open(), deletions: [] }),
      report: async ({ jobs }) => {
        for (const report of jobs) {
          for (const event of z.parse(jobReportSchema, report).events) {
            if (
              event.type === "entry" &&
              (event.record.kind === JOB_SUCCEEDED || event.record.kind === JOB_FAILED)
            ) {
              ends.set(report.jobId, event.record.kind);
            }
          }
        }
        if (ends.size === runs.length) Deferred.doneUnsafe(ended, Effect.succeed(ends));
        return { runs: open(), deletions: [], refused: [] };
      },
    });
    const hub = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    hub.on("error", fail);
    yield* Effect.promise(() => once(hub, "listening"));
    onTestFinished(() => {
      hub.close();
    });
    hub.on("connection", (socket) => {
      socket.on("error", fail);
      socket.addEventListener("message", ({ data: text }) => {
        assert(typeof text === "string", "the Runner sent a binary message");
        if (text === HEARTBEAT_PING) return socket.send(HEARTBEAT_PONG);
        void answer(text, undefined).then((reply) => reply && socket.send(reply), fail);
      });
    });
    return { url: urlOf(hub), ended: Deferred.await(ended), failed: Deferred.await(failed) };
  });

/**
 * Starts a Runner with `env` and a Groq API key saved by `login`, which runs until the test ends.
 * Gives back an Effect that fails when the Runner does, as when it refuses to start.
 */
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
    const runner = yield* runnerCli.pipe(
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
    return Fiber.join(runner).pipe(Effect.andThen(Effect.die(new Error("The Runner stopped"))));
  });

/** Waits for every job to end, failing at once when the Runner or a stand-in fails first. */
const untilEnded = (
  hub: Effect.Success<ReturnType<typeof standInHub>>,
  model: Effect.Success<ReturnType<typeof standInModel>>,
  runner: Effect.Effect<never, unknown>,
) => Effect.raceAllFirst([hub.ended, hub.failed, model.failed, runner]);

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
      const runner = yield* startRunner({ HUB_URL: hub.url });

      const ended = yield* untilEnded(hub, model, runner);

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
      const runner = yield* startRunner({
        HUB_URL: hub.url,
        RUNNER_MODEL_BASE_URL: `${model.url}/base/v1`,
      });

      const ended = yield* untilEnded(hub, model, runner);

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
