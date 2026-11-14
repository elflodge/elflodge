import { type Kysely, sql } from "kysely";

// When the hub, by its clock, last applied a report of the job's current run, to within
// `SEEN_WRITE_INTERVAL_MS`; null until the run first reports, as a resume starts a new one, while
// its placement stands in. A Runner that stays connected can stop reporting one job, as when its
// journal's storage fails, so the Runner's own `lastSeenAt` cannot tell (`statusUnknown`).
// `runId` is the run whose reports may write that time, set by placement and resume. A report
// writes the time only while it holds the row's run, and Postgres checks that against the row's
// latest version once it holds the row's lock, so a report of a run a resume replaced never writes
// it, without the report taking the job row's lock.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("elflodge")
    .alterTable("jobProgress")
    .addColumn("lastReportedAt", "timestamptz")
    .addColumn("runId", "uuid")
    .execute();
  // Jobs already placed carry on reporting their current run.
  await sql`
    update elflodge."jobProgress" as p set "runId" = j."runId"
    from elflodge.job as j
    where j.id = p."jobId" and j."placedAt" is not null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("elflodge")
    .alterTable("jobProgress")
    .dropColumn("runId")
    .dropColumn("lastReportedAt")
    .execute();
}
