import type { Kysely } from "kysely";

// A key keeps its creator in its own metadata for key management. Different callers can share
// the same key, so a submission identifies the key used. Dropping each copy also drops its CHECK.
// A hub that still writes the copy fails those writes during a Workers upgrade (ADR 0047).
// Restoring the discarded creator IDs requires a pre-upgrade backup.
export async function up(db: Kysely<unknown>): Promise<void> {
  const schema = db.schema.withSchema("elflodge");
  for (const table of ["batch", "job", "usageRecord"]) {
    await schema.alterTable(table).dropColumn("keyCreatorUserId").execute();
  }
}
