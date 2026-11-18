import { type Kysely, sql } from "kysely";

// When the hub wrote each Usage record, by its clock: the day a record's use counts in when usage
// is read by day (ADR 0044). The record's `endedAt` is the Runner's clock for an end its Runner
// reports, and a report can reach the hub long after the end, so a day dated by it could still
// change once read; this time is set as the record is written, so a day that has passed keeps what
// it holds. A record written before this column took its end, the nearest time it has.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("elflodge")
    .alterTable("usageRecord")
    .addColumn("recordedAt", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
  await db
    .$extendTables<{ usageRecord: { recordedAt: Date; endedAt: Date } }>()
    .withSchema("elflodge")
    .updateTable("usageRecord")
    .set((eb) => ({ recordedAt: eb.ref("endedAt") }))
    .execute();
  // Usage is read over a window of days.
  await db.schema
    .withSchema("elflodge")
    .createIndex("usageRecord_recordedAt_idx")
    .on("usageRecord")
    .column("recordedAt")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema("elflodge").dropIndex("usageRecord_recordedAt_idx").execute();
  await db.schema
    .withSchema("elflodge")
    .alterTable("usageRecord")
    .dropColumn("recordedAt")
    .execute();
}
