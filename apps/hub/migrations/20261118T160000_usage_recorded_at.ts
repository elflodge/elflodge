import { type Kysely, sql } from "kysely";

// When each Usage record was written: Postgres's `now()`, the start of the transaction that writes
// it, so the database's clock. A record's use counts on its UTC day when usage is read by day (ADR
// 0044). The record's `endedAt` is the Runner's clock for an end its Runner reports, and a report
// can reach the hub long after the end, so a day dated by it could change long after it was read.
// `recordedAt` never changes once written; only a transaction that starts before UTC midnight and
// commits after it adds to a day that a read may already have shown. A record written before this
// column took its end, the nearest time it has.
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
