import { type Kysely, sql } from "kysely";

// What each Usage record's use went to, by model (`provider/modelId`) and by tool: pi's additive
// counters for each name whose counters changed since the job's previous end, as `{ "models": {},
// "tools": {} }`, their differences adding up exactly to the record's own `totalTokens` and
// `costUsd`, except at the first end after this migration of a job that had a Usage record and
// used more since (ADR 0051). Not null with no default, so an end a previous release writes, which
// gives no split, fails in full: its record and the job's recorded totals are written by one
// statement or transaction, so neither a record without a split nor a moved baseline without
// `recordedUsage` is kept. Records written before the column took empty maps: what they used
// cannot be split now.
//
// `job.recordedUsage` is the usage the job's records already count: its progress's `usage` at its
// last end, beside the totals then in `recordedTotalTokens` and `recordedCostUsd`. Each end
// subtracts it. A job with no Usage record keeps the empty maps, which are exact for a job awaiting
// its first end. A job with one takes its progress's usage now, since its usage at its last end was
// never kept: exact where it has used nothing since, and otherwise short by what it used between
// that end and this migration. Its next end's entries then fall short of the record's totals by
// that much, which reads as unattributed use, and never exceed them, so nothing is counted twice.
// Deciding by the records rather than by the recorded totals also covers a job whose records
// counted no tokens or cost while its usage, from a Runner of the older protocol, held counters.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("elflodge")
    .alterTable("usageRecord")
    .addColumn("usage", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'{"models": {}, "tools": {}}'::jsonb`),
    )
    .execute();
  await db.schema
    .withSchema("elflodge")
    .alterTable("usageRecord")
    .alterColumn("usage", (col) => col.dropDefault())
    .execute();
  await db.schema
    .withSchema("elflodge")
    .alterTable("job")
    .addColumn("recordedUsage", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'{"models": {}, "tools": {}}'::jsonb`),
    )
    .execute();
  await db
    .$extendTables<{
      job: { id: string; recordedUsage: unknown };
      jobProgress: { jobId: string; usage: unknown };
      usageRecord: { id: number; jobId: string };
    }>()
    .withSchema("elflodge")
    .updateTable("job")
    .from("jobProgress")
    .set((eb) => ({ recordedUsage: eb.ref("jobProgress.usage") }))
    .whereRef("jobProgress.jobId", "=", "job.id")
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("usageRecord")
          .select("usageRecord.id")
          .whereRef("usageRecord.jobId", "=", "job.id"),
      ),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema("elflodge").alterTable("job").dropColumn("recordedUsage").execute();
  await db.schema.withSchema("elflodge").alterTable("usageRecord").dropColumn("usage").execute();
}
