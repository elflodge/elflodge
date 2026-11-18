import { sql, type Kysely } from "kysely";

// Listing a Runner's jobs, newest first, in every status (`GET /jobs?runnerId=…`), and reading
// them when it is removed. The partial index the Runner's sync reads takes the same order, so a
// read of what a Runner holds now, paused jobs included, stops after a page; a plain index on the
// Runner alone would read all of a busy Runner's history to sort it.
export async function up(db: Kysely<unknown>): Promise<void> {
  const schema = db.schema.withSchema("elflodge");
  await schema.createIndex("job_runnerId_id_idx").on("job").columns(["runnerId", "id"]).execute();
  await schema.dropIndex("job_runnerId_unfinished_idx").execute();
  await schema
    .createIndex("job_runnerId_unfinished_idx")
    .on("job")
    .columns(["runnerId", "id"])
    .where(sql.ref("status"), "in", ["queued", "running", "paused"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const schema = db.schema.withSchema("elflodge");
  await schema.dropIndex("job_runnerId_unfinished_idx").execute();
  await schema
    .createIndex("job_runnerId_unfinished_idx")
    .on("job")
    .columns(["runnerId"])
    .where(sql.ref("status"), "in", ["queued", "running"])
    .execute();
  await schema.dropIndex("job_runnerId_id_idx").execute();
}
