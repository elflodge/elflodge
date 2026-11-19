import { Effect, Layer } from "effect";
import ensureError from "ensure-error";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { createApp } from "./app.ts";
import { databaseAndAuthLayer } from "./auth/auth.ts";
import { sweepUnusedBlobs } from "./blobs.ts";
import { DASHBOARD_BASE } from "./dashboard.ts";
import { RunnerConnections } from "./platform.ts";
import {
  authSettings,
  hubSettings,
  jobLimitSettingsLayer,
  readConfig,
  type HubSettings,
} from "./settings.ts";

export { RunnerConnection } from "./runner-connection.ts";

// The hub on Cloudflare Workers: each request opens its own database connection through Hyperdrive,
// and a Durable Object per Runner holds the Runner's WebSocket.

/** The hub's settings, read for each request from the Worker's variables and secrets. */
function readSettings(): HubSettings {
  try {
    return readConfig(hubSettings);
  } catch (error) {
    // Without them Better Auth would guess the URL from each request, which its docs warn against,
    // and sign sessions with a development secret; a hub missing either answers no request that
    // needs them, though the dashboard's files and the redirect from `/` still answer. Wrangler
    // refuses to deploy without them, so this catches a secret removed from a live hub, or a setting
    // Wrangler cannot check, such as a limit's default above its maximum: its callers learn only
    // that it is unavailable, and the operator finds which setting in the logs.
    console.error(ensureError(error).message);
    throw new HTTPException(503);
  }
}

/** The Workers platform's services for one request. */
function workersLayer(env: Env) {
  const settings = readSettings();
  return Layer.mergeAll(
    // Aborting a usage request through local Hyperdrive left its query waiting in Postgres.
    // Hyperdrive pools by transaction, so Kysely cannot rely on a stable backend PID here.
    databaseAndAuthLayer(env.HYPERDRIVE.connectionString, authSettings(settings), "ignore query"),
    jobLimitSettingsLayer(settings),
    Layer.succeed(RunnerConnections, {
      drop: (runnerId) =>
        Effect.tryPromise(() => env.RUNNER_CONNECTION.getByName(runnerId).dropConnections()),
      hint: (runnerId) =>
        Effect.tryPromise(() => env.RUNNER_CONNECTION.getByName(runnerId).requestSync()),
    }),
  );
}

const app = createApp<Env>({
  run: (env, effect) => Effect.runPromise(Effect.provide(effect, workersLayer(env))),
  acceptRunner: (env, request, runnerId) =>
    env.RUNNER_CONNECTION.getByName(runnerId).fetch(request),
  hubUrl: () => readSettings().hubUrl,
  dashboard: new Hono<{ Bindings: Env }>()
    .get("/assets/*", (c) => c.notFound())
    .get("*", (c) =>
      c.req.header("Sec-Fetch-Mode") === "navigate"
        ? c.env.ASSETS.fetch(new Request(new URL(DASHBOARD_BASE, c.req.url), c.req.raw))
        : c.notFound(),
    ),
});

export default {
  fetch: app.fetch,
  // The Cron Trigger's sweep of Blobs nothing uses, every hour (`wrangler.jsonc`). A sweep that
  // fails is logged and recorded by Cloudflare as a failed invocation; the next trigger tries again.
  scheduled: (_controller, env, context) => {
    context.waitUntil(
      Effect.runPromise(
        sweepUnusedBlobs.pipe(Effect.tapCause(Effect.logError), Effect.provide(workersLayer(env))),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
