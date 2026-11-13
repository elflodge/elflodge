import type { Kysely } from "kysely";

// When the job's Runner last reported its current run, to within `SEEN_WRITE_INTERVAL_MS`; null
// until it first does. Its run's placement stands in before then, so a run's reports are compared
// with the later of the two and an earlier run's time needs no reset. A Runner that stays connected
// can stop reporting one job, as when its journal's storage fails, so the Runner's own `lastSeenAt`
// cannot tell (`statusUnknown`).
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("elflodge")
    .alterTable("jobProgress")
    .addColumn("lastReportedAt", "timestamptz")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("elflodge")
    .alterTable("jobProgress")
    .dropColumn("lastReportedAt")
    .execute();
}
