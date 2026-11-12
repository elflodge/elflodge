import type { Kysely } from "kysely";

// What a Runner reports about itself in its hello, replaced by each hello. Null until a Runner
// reports something the hub can read: a Runner older than the field reports nothing, and a record
// that fails the contract is not kept.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("elflodge")
    .alterTable("runner")
    .addColumn("capabilities", "jsonb")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema("elflodge").alterTable("runner").dropColumn("capabilities").execute();
}
