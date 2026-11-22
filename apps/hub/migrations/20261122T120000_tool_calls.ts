import { type Kysely, sql } from "kysely";

// How many times a job's tools were called, by tool name, `{ "<tool>": n }` (ADR 0052): the hub
// counts each report's `pi.tool-result` entries as it stores them. `jobProgress.toolCalls` is the
// job's count over the Events the hub holds. `job.recordedToolCalls` is that count at the job's
// last end, which its Usage records already hold, moved with `recordedUsage`. `usageRecord.toolCalls`
// is the end's own calls, the count less the recorded one.
//
// Nothing is counted from the Events already stored: an existing job's count starts from the
// upgrade, and existing records get empty maps. A previous release still applying reports while the
// upgrade rolls out stores their Events without counting them, which leaves those jobs' counts
// short of their Events, as the stored ones are. Its ends fail, as `usageRecord.toolCalls` has no
// default and its record and the job's recorded counts are written by one statement or transaction.
export async function up(db: Kysely<unknown>): Promise<void> {
  const empty = sql`'{}'::jsonb`;
  await db.schema
    .withSchema("elflodge")
    .alterTable("jobProgress")
    .addColumn("toolCalls", "jsonb", (col) => col.notNull().defaultTo(empty))
    .execute();
  await db.schema
    .withSchema("elflodge")
    .alterTable("job")
    .addColumn("recordedToolCalls", "jsonb", (col) => col.notNull().defaultTo(empty))
    .execute();
  await db.schema
    .withSchema("elflodge")
    .alterTable("usageRecord")
    .addColumn("toolCalls", "jsonb", (col) => col.notNull().defaultTo(empty))
    .execute();
  await db.schema
    .withSchema("elflodge")
    .alterTable("usageRecord")
    .alterColumn("toolCalls", (col) => col.dropDefault())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema("elflodge")
    .alterTable("usageRecord")
    .dropColumn("toolCalls")
    .execute();
  await db.schema
    .withSchema("elflodge")
    .alterTable("job")
    .dropColumn("recordedToolCalls")
    .execute();
  await db.schema
    .withSchema("elflodge")
    .alterTable("jobProgress")
    .dropColumn("toolCalls")
    .execute();
}
