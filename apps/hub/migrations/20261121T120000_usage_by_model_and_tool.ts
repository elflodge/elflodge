import { type Kysely, sql } from "kysely";

// What each Usage record's use went to, by model (`provider/modelId`) and by tool: pi's additive
// counters for each name whose counters changed since the job's previous end, as `{ "models": {},
// "tools": {} }`, their differences adding up to the record's own `totalTokens` and `costUsd` for
// every end whose previous end was recorded with them (ADR 0051). Not null with no default, so an end a previous release writes, which gives no split, fails
// in full: its record and the job's recorded totals are written by one statement or transaction,
// so neither a record without a split nor a moved baseline without `recordedUsage` is kept.
// Records written before the column took empty maps: what they used cannot be split now.
//
// `job.recordedUsage` is the usage the job's records already count: its progress's `usage` at its
// last end, beside the totals then in `recordedTotalTokens` and `recordedCostUsd`. Each end
// subtracts it. A job whose records have counted nothing keeps the empty maps, which are exact, as
// for a job that has not ended. One whose records have counted something takes its progress's usage
// now, since its usage at its last end was never kept: exact where it has used nothing since, and
// otherwise short by what it used between that end and this migration. Its next end's entries
// then fall short of the record's totals by that much, which reads as unattributed use, and never
// exceed them, so nothing is counted twice.
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
      job: {
        id: string;
        recordedUsage: unknown;
        recordedTotalTokens: number;
        recordedCostUsd: number;
      };
      jobProgress: { jobId: string; usage: unknown; totalTokens: number; costUsd: number };
    }>()
    .withSchema("elflodge")
    .updateTable("job")
    .from("jobProgress")
    .set((eb) => ({ recordedUsage: eb.ref("jobProgress.usage") }))
    .whereRef("jobProgress.jobId", "=", "job.id")
    .where((eb) =>
      eb.or([
        eb("job.recordedTotalTokens", "<>", eb.lit(0)),
        eb("job.recordedCostUsd", "<>", eb.lit(0)),
      ]),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema("elflodge").alterTable("job").dropColumn("recordedUsage").execute();
  await db.schema.withSchema("elflodge").alterTable("usageRecord").dropColumn("usage").execute();
}
