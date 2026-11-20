import { type Kysely, sql } from "kysely";

// New chunks use the database's transaction start time, like Usage records (ADR 0044).
// The rename preserves existing timestamps, which were sampled on the hub before the write.
// During a Workers upgrade, an old hub's Runner reports fail on the missing storedAt column.
// Runners resend their unacknowledged events after the new hub takes over (ADR 0047).
export async function up(db: Kysely<unknown>): Promise<void> {
  const schema = db.schema.withSchema("elflodge");
  await schema.alterTable("jobEventChunk").renameColumn("storedAt", "recordedAt").execute();
  await schema
    .alterTable("jobEventChunk")
    .alterColumn("recordedAt", (column) => column.setDefault(sql`now()`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const schema = db.schema.withSchema("elflodge");
  await schema
    .alterTable("jobEventChunk")
    .alterColumn("recordedAt", (column) => column.dropDefault())
    .execute();
  await schema.alterTable("jobEventChunk").renameColumn("recordedAt", "storedAt").execute();
}
