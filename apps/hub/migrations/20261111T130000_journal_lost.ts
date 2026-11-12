import type { Kysely } from "kysely";

// A job whose Runner found its journal missing or behind the hub's copy fails with `journalLost`.
// Postgres cannot remove a value from an enum, so there is no `down`.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("elflodge")
    .alterType("jobFailureReason")
    .addValue("journalLost")
    .execute();
}
