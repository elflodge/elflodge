import { sql, type Kysely } from "kysely";

// Counting the Organization's unfinished jobs by status (`GET /jobs/counts`): the index holds only
// unfinished jobs, so the count does not read the ended ones, which most jobs are, and covers it, so
// Postgres skips reading the jobs' rows on pages a vacuum marked all-visible.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("elflodge")
    .createIndex("job_status_unfinished_idx")
    .on("job")
    .columns(["status"])
    .where(sql.ref("status"), "in", ["queued", "running", "paused"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema("elflodge").dropIndex("job_status_unfinished_idx").execute();
}
