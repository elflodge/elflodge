import { type Kysely, sql } from "kysely";

// GET /jobs?statusUnknown=true checks the last report only for queued or running jobs already
// sent to a Runner. This index gives the global list those IDs in page order. Excluding finished
// and unsent jobs bounds the scan by sent work even when the list has no matches. The
// Runner-leading unfinished index serves per-Runner reads and includes paused jobs.
// Recheck this predicate against isStatusUnknown in jobs.ts if the status rule changes.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("elflodge")
    .createIndex("job_placed_queued_running_id_idx")
    .on("job")
    .column("id")
    .where(sql.ref("placedAt"), "is not", null)
    .where(sql.ref("status"), "in", ["queued", "running"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema("elflodge").dropIndex("job_placed_queued_running_id_idx").execute();
}
