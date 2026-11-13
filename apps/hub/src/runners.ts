import { type Runner, type RunnerCapabilities, runnerCapabilitiesSchema } from "contract";
import { Effect } from "effect";
import { type AliasableExpression, type Expression, expressionBuilder } from "kysely";
import * as z from "zod/mini";

import { Db } from "./db/database.ts";
import type { Database, RunnerId, RunnerUpdate } from "./db/types.ts";
import { RunnerConnections } from "./platform.ts";

// Runners are recorded by when the hub last heard from them and what their latest hello reported.
// These writes may arrive late or out of order, so each one moves `lastSeenAt` forward or does
// nothing, and their order never matters.

/**
 * Records that the Runner said hello under `name` at `seenAt`, with what it reported about itself,
 * which replaces what an earlier hello reported, so a Runner that reports nothing shows nothing.
 */
export function recordRunnerHello(
  runnerId: RunnerId,
  name: string,
  capabilities: RunnerCapabilities | undefined,
  seenAt: Date,
) {
  return Db.use((database) =>
    database.query((db) =>
      db
        .updateTable("runner")
        .set({
          name,
          lastSeenAt: seenAt,
          capabilities: capabilities ?? null,
        } satisfies RunnerUpdate)
        .where("id", "=", runnerId)
        .where("lastSeenAt", "<", seenAt)
        .execute(),
    ),
  ).pipe(Effect.asVoid);
}

/** Records that the hub heard from the Runner at `seenAt`: a sync or a report. */
export function recordRunnerSeen(runnerId: RunnerId, seenAt: Date) {
  return Db.use((database) =>
    database.query((db) =>
      db
        .updateTable("runner")
        .set({ lastSeenAt: seenAt })
        .where("id", "=", runnerId)
        .where("lastSeenAt", "<", seenAt)
        .execute(),
    ),
  ).pipe(Effect.asVoid);
}

/**
 * Lists every Runner the hub has recorded, as its API returns them. Capabilities this hub cannot
 * read, as a newer Runner may have reported to a newer hub before this one replaced it, are null
 * rather than failing the list.
 */
export const listRunners = Db.use((database) =>
  database.query(async (db): Promise<Runner[]> => {
    const now = new Date();
    const rows = await db
      .selectFrom("runner")
      .select((eb) => [
        "id",
        "name",
        "lastSeenAt",
        "capabilities",
        connectedOf(eb.ref("lastSeenAt"), now).as("connected"),
      ])
      .execute();
    return rows.map((runner) => ({
      ...runner,
      capabilities: z.safeParse(runnerCapabilitiesSchema, runner.capabilities).data ?? null,
    }));
  }),
);

/**
 * How often a Runner syncs when nothing prompts it sooner, told to it in the hub's answer to its
 * hello (ADR 0026): three minutes, for every deployment until one shows a reason to tune it.
 */
export const SYNC_INTERVAL_MS = 180_000;

/**
 * How long a Runner may go unheard before it counts as gone: a sync it missed, the next one, and a
 * minute for it to arrive. Only Runners heard from more recently are told to sync.
 */
export const GONE_AFTER_MS = 2 * SYNC_INTERVAL_MS + 60_000;

/**
 * How long a socket's sighting of its Runner, or a report's of its job, goes unwritten when nothing
 * else changes: a third of the sync interval, so a Runner that syncs on time is never recorded as
 * more than about one interval old. Equal to the interval, a sync arriving a little early would
 * skip its write, and the next one's could find `lastSeenAt` nearly two intervals old. Kubernetes'
 * kubelet likewise renews its node's lease every quarter of the lease's duration.
 */
export const SEEN_WRITE_INTERVAL_MS = SYNC_INTERVAL_MS / 3;

/**
 * Whether a Runner last seen at `lastSeenAt` counts as connected at `now`: heard from within
 * `GONE_AFTER_MS`. Recent protocol traffic, not an open socket: a socket that died without closing
 * shows nothing, and on Workers the hub does not see a heartbeat. Worked out where it is read, so
 * nothing records a disconnection, and no order of an old socket's close and a new one's hello can
 * leave it wrong.
 */
export function connectedOf(lastSeenAt: Expression<Date>, now: Date): AliasableExpression<boolean> {
  const eb = expressionBuilder<Database>();
  // pg reads a boolean as one.
  return eb(lastSeenAt, ">", eb.val(new Date(now.getTime() - GONE_AFTER_MS))).$castTo<boolean>();
}

/**
 * Tells every connected Runner (`connectedOf`) to sync now, as for a new job. A
 * Runner that is not connected after all misses nothing: its next sync finds the same jobs.
 */
export const hintConnectedRunners = Effect.gen(function* () {
  const database = yield* Db;
  const connections = yield* RunnerConnections;
  const now = new Date();
  const runners = yield* database.query((db) =>
    db
      .selectFrom("runner")
      .select("id")
      .where((eb) => connectedOf(eb.ref("lastSeenAt"), now))
      .execute(),
  );
  yield* Effect.forEach(runners, (runner) => connections.hint(runner.id), {
    concurrency: "unbounded",
    discard: true,
  });
});
