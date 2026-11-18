import type { Kysely } from "kysely";

// Counting each listed Batch's jobs by status (`GET /batches`) from the index alone, without
// reading the jobs' rows.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("elflodge")
    .createIndex("job_batchUid_status_idx")
    .on("job")
    .columns(["batchUid", "status"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema("elflodge").dropIndex("job_batchUid_status_idx").execute();
}
