import path from "node:path";

import * as NodeRuntime from "@effect/platform-node-shared/NodeRuntime";
import { Config, Effect, Layer, Option, Redacted, Schedule } from "effect";
import ensureError from "ensure-error";

import { createApp, decideRunnerUpgrade } from "./app.ts";
import { sweepUnusedBlobs } from "./blobs.ts";
import { migrateDatabase } from "./db/migrate.ts";
import { sweepInvitations } from "./invitations.ts";
import { dashboardFiles } from "./node/dashboard.ts";
import { NodeRunnerSockets, nodeServices } from "./node/layers.ts";
import { startServer, stopServer } from "./node/server.ts";
import type { HubServices } from "./platform.ts";
import { type HubSettings, hubSettings, settingsProblems } from "./settings.ts";
import { setUpOrganization } from "./setup.ts";

// The hub as a Node process, which its Docker image runs (ADR 0014). It runs as a single process:
// two would split Runners' connections between them. On start it migrates the database and, unless
// the Organization exists, creates it and its owner from `ADMIN_EMAIL` and `ADMIN_PASSWORD` or
// prints a setup link (ADR 0015), then serves until `SIGINT` or `SIGTERM`. It runs as Effect's
// example of an application entry point does, a layer started with `Layer.launch` under
// `NodeRuntime.runMain`, which the Runner's entry point uses too: a signal interrupts it, and the
// server stops before the services it runs on.

/** The Node hub's settings, read from the environment by Effect's default `Config` source. */
const nodeSettings = Config.all({
  hub: hubSettings,
  databaseUrl: Config.Redacted("DATABASE_URL"),
  port: Config.Port("PORT").pipe(Config.withDefault(8787)),
  host: Config.String("HOST").pipe(Config.option),
  adminEmail: Config.String("ADMIN_EMAIL").pipe(Config.option),
  adminPassword: Config.Redacted("ADMIN_PASSWORD").pipe(Config.option),
});

/** Tells the operator why the hub cannot start, and ends it with a failing exit code. */
function refuse(message: string) {
  return Effect.sync(() => {
    console.error(message);
    process.exitCode = 1;
  });
}

/**
 * The dashboard's build: the copy beside the built hub (`pack.copy` in `vite.config.ts`), or the
 * dashboard's own when the hub runs from source, as its tests run it.
 */
const dashboardRoot = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "../../dashboard/dist/client")
  : path.join(import.meta.dirname, "dashboard");

/**
 * The hub's server on `port`, at the address `host` or on every interface, with `settings`, running
 * each request on the services it is given. Stopping drains before it releases: the server stops
 * before those services, so Runners' sockets close and the server finishes its requests first.
 */
function hubServer(port: number, host: string | undefined, settings: HubSettings) {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const run = Effect.runPromiseWith(yield* Effect.context<HubServices>());
      const app = createApp<object>({
        run: (_env, effect) => run(effect),
        acceptRunner: () => {
          // crossws takes every upgrade in the server's `upgrade` event before the app sees the
          // request, so only requests the decision refuses reach the app's Runner route here.
          throw new Error("The Node hub accepts Runners' sockets in its upgrade hook");
        },
        hubUrl: () => settings.hubUrl,
        dashboard: dashboardFiles(dashboardRoot),
      });
      const sockets = yield* NodeRunnerSockets;
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            startServer(
              app.fetch,
              (request) => run(decideRunnerUpgrade(request)),
              sockets,
              port,
              host,
            ),
          catch: ensureError,
        }),
        (server) =>
          Effect.promise(() => {
            sockets.closeAll();
            return stopServer(server);
          }),
      );
    }),
  );
}

/**
 * The sweep of content nothing uses, at start and at the top of every hour after, in UTC, as the
 * Workers hub's Cron Trigger in `wrangler.jsonc` runs it there with the same expression; a sweep
 * that fails is logged, and the next one tries again.
 */
const sweeper = Layer.effectDiscard(
  Effect.forkScoped(
    Effect.all([sweepUnusedBlobs, sweepInvitations]).pipe(
      Effect.catchCause(Effect.logError),
      Effect.repeat(Schedule.cron("0 * * * *", "UTC")),
    ),
  ),
);

Effect.gen(function* () {
  const settings = yield* nodeSettings;
  const databaseUrl = Redacted.value(settings.databaseUrl);
  yield* Effect.tryPromise({
    try: async () => {
      // Migrations sit beside `src` and `dist` alike, so the path holds before and after building.
      await migrateDatabase(databaseUrl, path.join(import.meta.dirname, "../migrations"));
      await setUpOrganization(databaseUrl, {
        owner: {
          email: Option.getOrUndefined(settings.adminEmail),
          password: Option.getOrUndefined(Option.map(settings.adminPassword, Redacted.value)),
        },
        hubUrl: settings.hub.hubUrl,
        canPrintSetupLink: true,
      });
    },
    catch: ensureError,
  });
  return yield* Layer.launch(
    Layer.mergeAll(
      hubServer(settings.port, Option.getOrUndefined(settings.host), settings.hub),
      sweeper,
    ).pipe(Layer.provide(nodeServices(settings.hub, databaseUrl))),
  );
}).pipe(
  Effect.catchTag("ConfigError", (error) =>
    refuse(`The hub is not configured: ${settingsProblems(error)}`),
  ),
  Effect.catch((error) => refuse(error.message)),
  NodeRuntime.runMain,
);
