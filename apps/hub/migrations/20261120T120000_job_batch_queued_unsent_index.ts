import { type Kysely, sql } from "kysely";

// Counting each listed Batch's unsent queued jobs that wait for its Canary: the predicate and the
// Canary flag cover the count, so Postgres skips the jobs' rows on pages a vacuum marked all-visible.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("elflodge")
    .createIndex("job_batchUid_queued_unsent_idx")
    .on("job")
    .columns(["batchUid", "inCanary"])
    .where(sql.ref("status"), "=", "queued")
    .where(sql.ref("placedAt"), "is", null)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema("elflodge").dropIndex("job_batchUid_queued_unsent_idx").execute();
}
