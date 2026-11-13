import type { Kysely } from "kysely";

// When the hub, by its clock, last applied a report of the job's current run, to within
// `SEEN_WRITE_INTERVAL_MS`; null until the run first reports, as a resume starts a new one, while
// its placement stands in. A Runner that stays connected can stop reporting one job, as when its
// journal's storage fails, so the Runner's own `lastSeenAt` cannot tell (`statusUnknown`).
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
