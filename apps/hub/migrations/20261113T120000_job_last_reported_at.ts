import type { Kysely } from "kysely";

// When the hub, by its clock, last applied a report of the job's current run, to within
// `SEEN_WRITE_INTERVAL_MS`; null until the run first reports, as a resume starts a new one, while
// its placement stands in. A Runner that stays connected can stop reporting one job, as when its
// journal's storage fails, so the Runner's own `lastSeenAt` cannot tell (`statusUnknown`).
// `runId` is the run whose reports may write that time, set by placement and resume. A report
// writes the time only while it holds the row's run, and Postgres checks that against the row's
// latest version once it holds the row's lock, so a report of a run a resume replaced never writes
// it, without the report taking the job row's lock. Null while no run may write it: before the job
// is first placed, and from the resume of a job that never started until it is placed again.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("elflodge")
    .alterTable("jobProgress")
    .addColumn("lastReportedAt", "timestamptz")
    .addColumn("runId", "uuid")
    .execute();
  // Jobs that can still report carry on with their current run; any other job gets its next run
  // from the resume or placement that restarts it.
  await db
    .$extendTables<{
      job: { id: string; runId: string | null; status: string; placedAt: Date | null };
      jobProgress: { jobId: string; runId: string | null };
    }>()
    .withSchema("elflodge")
    .updateTable("jobProgress as p")
    .from("job as j")
    .set((eb) => ({ runId: eb.ref("j.runId") }))
    .whereRef("j.id", "=", "p.jobId")
    .where("j.status", "in", ["queued", "running"])
    .where("j.placedAt", "is not", null)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("elflodge")
    .alterTable("jobProgress")
    .dropColumn("runId")
    .dropColumn("lastReportedAt")
    .execute();
}
