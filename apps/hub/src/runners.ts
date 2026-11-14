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
 * hello (ADR 0026): a minute. Its pass over every held job is what keeps each job's recorded report
 * recent, so the interval bounds how soon `GONE_AFTER_MS` can be.
 */
export const SYNC_INTERVAL_MS = 60_000;

/**
 * How long a Runner, or a job's current run, may go unheard before the hub says so (ADR 0042): two
 * minutes, how soon a caller should learn that the hub has lost contact, chosen rather than derived.
 * A healthy Runner's recorded times are at most about 77 seconds old: an interval with its jitter
 * (66 seconds), a pass over every held job and its report (under a second, measured with 64 idle jobs),
 * and `SEEN_WRITE_INTERVAL_MS`. The rest is headroom for a slow host or database. A dropped
 * connection the Runner redials can show for a moment, which is true while it lasts. Only Runners
 * heard from more recently are told to sync.
 */
export const GONE_AFTER_MS = 120_000;

/**
 * How long a socket's sighting of its Runner, or a report's of its job, goes unwritten when nothing
 * else changes: ten seconds, so a recorded time is never more than that older than what the hub
 * last heard, whatever the sync interval. It spares a busy Runner's reports, every few seconds, a
 * write each.
 */
export const SEEN_WRITE_INTERVAL_MS = 10_000;

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
