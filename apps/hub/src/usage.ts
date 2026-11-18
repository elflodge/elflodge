import {
  batchIdSchema,
  finalJobStatusSchema,
  type Labels,
  MAX_USAGE_DAYS,
  type Usage,
  type UsageGroup,
  type UsageGroupBy,
  type UsageReport,
} from "contract";
import { DateTime, Duration, Effect } from "effect";
import {
  type AliasableExpression,
  type Expression,
  type ExpressionBuilder,
  expressionBuilder,
  type Kysely,
  sql,
} from "kysely";
import { jsonArrayFrom, jsonBuildObject } from "kysely/helpers/postgres";
import * as z from "zod/mini";

import { requireRolePermission } from "./auth/auth.ts";
import { Db } from "./db/database.ts";
import type { ApikeyId, BatchUid, Database, JobStatus, RunnerId } from "./db/types.ts";
import { InvalidInput } from "./invalid-input.ts";

// The Organization's usage, added up from its Usage records: each records what one job used up to
// one of its ends, since its previous end, and stays when the job is deleted. A record counts on
// the UTC day the hub wrote it (`recordedAt`, ADR 0044).

/** What a read of usage asks for, beside its window. */
export interface UsageQuery {
  from?: string;
  to?: string;
  groupBy?: UsageGroupBy;
  /** With `groupBy`, how many groups to name; the rest are summed together. */
  limit: number;
  batchId?: string;
  keyId?: ApikeyId;
  runnerId?: RunnerId;
  statuses: readonly JobStatus[];
  labels?: Labels;
}

/** How many days a read covers when it names no `from`. */
const DEFAULT_DAYS = 30;

/**
 * The usage `query` asks for, read by the member signed in with `headers`, whose role must grant
 * reading it; a 403 error otherwise, and the window's problem when it is refused.
 */
export function readUsage(headers: Headers, query: UsageQuery) {
  return Effect.gen(function* () {
    yield* requireRolePermission(headers, { usage: ["read"] });
    const today = DateTime.startOf(yield* DateTime.now, "day");
    const window = yield* windowOf(query, today);
    const row = yield* Db.use((database) =>
      database.query((db) => selectUsage(db, window, query).executeTakeFirstOrThrow()),
    );
    const { groupBy } = query;
    return {
      from: window.from,
      to: window.to,
      usage: usageOf(row),
      ...(groupBy === undefined
        ? {}
        : {
            groups: row.groups.map((group) => groupOf(groupBy, group)),
            other: { groups: row.otherGroups, usage: usageOf(otherOf(row)) },
          }),
      days: row.days.map((day) => ({
        date: day.day,
        usage: usageOf(day),
        ...(groupBy === undefined
          ? {}
          : {
              groups: day.groups.map((group) => groupOf(groupBy, group)),
              other: { usage: usageOf(otherOf(day)) },
            }),
      })),
    } satisfies UsageReport;
  });
}

/** A window of whole UTC days, from `from` to `to`, both included, and the instants it spans. */
interface Window {
  from: string;
  to: string;
  /** The first instant of `from`. */
  start: Date;
  /** The first instant after `to`. */
  end: Date;
}

/**
 * The window `query` asks for, by default the `DEFAULT_DAYS` days ending `today`, or the problem
 * with it: a `from` after its `to`, or more than `MAX_USAGE_DAYS` days. The default `from`
 * always fits, so a problem is always the `from` given.
 */
function windowOf(query: Pick<UsageQuery, "from" | "to">, today: DateTime.Utc) {
  const to = query.to === undefined ? today : DateTime.makeUnsafe(query.to);
  const from =
    query.from === undefined
      ? DateTime.subtract(to, { days: DEFAULT_DAYS - 1 })
      : DateTime.makeUnsafe(query.from);
  const days = Duration.toDays(DateTime.distance(from, to)) + 1;
  const problem =
    days < 1
      ? "Must not be after `to`"
      : days > MAX_USAGE_DAYS
        ? `Must be at most ${MAX_USAGE_DAYS} days before \`to\`, counting both`
        : undefined;
  if (problem !== undefined) {
    return Effect.fail(new InvalidInput({ problems: [{ message: problem, path: ["from"] }] }));
  }
  return Effect.succeed<Window>({
    from: DateTime.formatIsoDateUtc(from),
    to: DateTime.formatIsoDateUtc(to),
    start: DateTime.toDateUtc(from),
    end: DateTime.toDateUtc(DateTime.add(to, { days: 1 })),
  });
}

/**
 * The one statement that reads the usage `query` asks for over `window`: the records' sums per day
 * and group (`cells`), each group ranked by its cost over the window, then its tokens, then its key
 * (`ranked`), the top `limit` groups named (`top`), and the window's and each day's sums, each day
 * holding every top group and the rest summed. Without `groupBy` every record is in one group, and
 * none is named.
 */
function selectUsage(db: Kysely<Database>, window: Window, query: UsageQuery) {
  const { groupBy } = query;
  const limit = groupBy === undefined ? 0 : query.limit;
  return (
    db
      .with("records", (qb) => {
        let records = qb
          .selectFrom("usageRecord")
          .where("usageRecord.recordedAt", ">=", window.start)
          .where("usageRecord.recordedAt", "<", window.end);
        const { statuses, labels, batchId, keyId, runnerId } = query;
        if (statuses.length > 0) {
          records = records.where("usageRecord.status", "=", (eb) =>
            eb.fn.any(eb.val([...statuses])),
          );
        }
        if (labels !== undefined && Object.keys(labels).length > 0) {
          records = records.where((eb) =>
            eb(
              "usageRecord.labels",
              "@>",
              eb.cast<Labels>(eb.val(JSON.stringify(labels)), "jsonb"),
            ),
          );
        }
        if (batchId !== undefined) {
          records = records.where("usageRecord.batchUid", "=", (eb) =>
            eb.selectFrom("batch").select("batch.uid").where("batch.id", "=", batchId),
          );
        }
        if (keyId !== undefined) records = records.where("usageRecord.submitterKeyId", "=", keyId);
        if (runnerId !== undefined) records = records.where("usageRecord.runnerId", "=", runnerId);
        return records.select((eb) => [
          eb
            .cast<string>(
              eb.fn("timezone", [eb.cast(eb.val("UTC"), "text"), eb.ref("usageRecord.recordedAt")]),
              "date",
            )
            .as("day"),
          groupKeyOf(eb, groupBy).as("groupKey"),
          "usageRecord.totalTokens",
          "usageRecord.costUsd",
          "usageRecord.submitterKeyName",
        ]);
      })
      // Added up as Postgres's exact `numeric` and `bigint`, not in JavaScript.
      .with("cells", (qb) =>
        qb
          .selectFrom("records as r")
          .select((eb) => [
            "r.day",
            "r.groupKey",
            eb.cast<number>(eb.fn.sum("r.totalTokens"), "bigint").as("totalTokens"),
            eb.fn.sum<number>("r.costUsd").as("costUsd"),
            // The hub has no call that renames a key, so a key's records all hold one name.
            eb.fn.max("r.submitterKeyName").as("keyName"),
          ])
          .groupBy(["r.day", "r.groupKey"]),
      )
      // Each group's sums over the window, by window functions over the cells rather than a join on
      // the group, which would lose the group whose key is null, such as records without the label.
      .with("grouped", (qb) =>
        qb
          .selectFrom("cells as c")
          .selectAll("c")
          .select((eb) => [
            eb.fn
              .sum<number>("c.costUsd")
              .over((over) => over.partitionBy("c.groupKey"))
              .as("groupCostUsd"),
            eb
              .cast<number>(
                eb.fn.sum("c.totalTokens").over((over) => over.partitionBy("c.groupKey")),
                "bigint",
              )
              .as("groupTotalTokens"),
            eb.fn
              .max("c.keyName")
              .over((over) => over.partitionBy("c.groupKey"))
              .as("groupKeyName"),
          ]),
      )
      // A group's cells share one rank, and every group has its own, as the key breaks every tie.
      .with("ranked", (qb) =>
        qb
          .selectFrom("grouped as g")
          .selectAll("g")
          .select((eb) =>
            eb.fn
              .agg<number>("dense_rank", [])
              .over((over) =>
                over
                  .orderBy("g.groupCostUsd", "desc")
                  .orderBy("g.groupTotalTokens", "desc")
                  .orderBy("g.groupKey", (order) => order.asc().nullsLast()),
              )
              .as("rank"),
          ),
      )
      // Named only now, so only the groups shown read a Batch or Runner.
      .with("top", (qb) =>
        qb
          .selectFrom((groups) =>
            groups
              .selectFrom("ranked as k")
              .select([
                "k.rank",
                "k.groupKey",
                "k.groupTotalTokens",
                "k.groupCostUsd",
                "k.groupKeyName",
              ])
              .distinct()
              .where("k.rank", "<=", limit)
              .as("t"),
          )
          .select((eb) => [
            "t.rank",
            "t.groupKey as value",
            groupNameOf(groupBy, eb.ref("t.groupKey"), eb.ref("t.groupKeyName")).as("name"),
            "t.groupTotalTokens as totalTokens",
            "t.groupCostUsd as costUsd",
          ]),
      )
      .with("days", (qb) =>
        qb
          .selectFrom((eb) =>
            eb
              .fn<{ series: Date }>("generate_series", [
                // Without time zones, so every step is a day.
                eb.cast(eb.val(window.from), "timestamp"),
                eb.cast(eb.val(window.to), "timestamp"),
                eb.cast(eb.val("1 day"), sql`interval`),
              ])
              .as("series"),
          )
          .select((eb) => eb.cast<string>("series.series", "date").as("day")),
      )
      .with("dayGroups", (qb) =>
        qb
          .selectFrom("days as d")
          .innerJoin("top as t", (join) => join.onTrue())
          .leftJoin("ranked as k", (join) =>
            join.onRef("k.day", "=", "d.day").onRef("k.rank", "=", "t.rank"),
          )
          .select((eb) => [
            "d.day",
            eb.fn
              .agg<GroupRow[]>("json_agg", [
                jsonBuildObject({
                  value: eb.ref("t.value"),
                  name: eb.ref("t.name"),
                  totalTokens: eb.fn.coalesce("k.totalTokens", eb.lit(0)),
                  costUsd: eb.fn.coalesce("k.costUsd", eb.lit(0)),
                }),
              ])
              .orderBy("t.rank")
              .as("groups"),
          ])
          .groupBy("d.day"),
      )
      .with("dayTotals", (qb) =>
        qb
          .selectFrom("ranked as k")
          .select((eb) => [
            "k.day",
            ...sumsOf(eb, "totalTokens", "costUsd"),
            ...sumsOf(eb, "otherTotalTokens", "otherCostUsd", limit),
          ])
          .groupBy("k.day"),
      )
      .selectFrom("ranked as k")
      .select((eb) => [
        ...sumsOf(eb, "totalTokens", "costUsd"),
        ...sumsOf(eb, "otherTotalTokens", "otherCostUsd", limit),
        eb.fn
          .count<number>("k.rank")
          .distinct()
          .filterWhere("k.rank", ">", limit)
          .as("otherGroups"),
        jsonArrayFrom(
          eb
            .selectFrom("top as t")
            .select(["t.value", "t.name", "t.totalTokens", "t.costUsd"])
            .orderBy("t.rank"),
        ).as("groups"),
        jsonArrayFrom(
          eb
            .selectFrom("days as d")
            .leftJoin("dayTotals as dt", "dt.day", "d.day")
            .leftJoin("dayGroups as dg", "dg.day", "d.day")
            .select((day) => [
              "d.day",
              day.fn.coalesce("dt.totalTokens", day.lit(0)).as("totalTokens"),
              day.fn.coalesce("dt.costUsd", day.lit(0)).as("costUsd"),
              day.fn.coalesce("dt.otherTotalTokens", day.lit(0)).as("otherTotalTokens"),
              day.fn.coalesce("dt.otherCostUsd", day.lit(0)).as("otherCostUsd"),
              day.fn
                .coalesce("dg.groups", day.cast<GroupRow[]>(day.val("[]"), "json"))
                .as("groups"),
            ])
            .orderBy("d.day"),
        ).as("days"),
      ])
  );
}

/** A group as the statement gives it: its key, its name where it has one, and its sums. */
interface GroupRow {
  value: string | null;
  name: string | null;
  totalTokens: number;
  costUsd: number;
}

/**
 * The sums of the ranked cells' tokens and cost, as `tokens` and `cost`, zeros when there are
 * none; with `limit`, only of the groups ranked after it.
 */
function sumsOf<T extends string, C extends string>(
  eb: ExpressionBuilder<{ k: { totalTokens: number; costUsd: number; rank: number } }, "k">,
  tokens: T,
  cost: C,
  limit?: number,
) {
  const tokensSum = eb.fn.sum<number>("k.totalTokens");
  const costSum = eb.fn.sum<number>("k.costUsd");
  return [
    eb
      .cast<number>(
        eb.fn.coalesce(
          limit === undefined ? tokensSum : tokensSum.filterWhere("k.rank", ">", limit),
          eb.lit(0),
        ),
        "bigint",
      )
      .as(tokens),
    eb.fn
      .coalesce(
        limit === undefined ? costSum : costSum.filterWhere("k.rank", ">", limit),
        eb.lit(0),
      )
      .as(cost),
  ] as const;
}

/** What groups a record, as text, by `groupBy`; every record in one group without it. */
function groupKeyOf(
  eb: ExpressionBuilder<Database, "usageRecord">,
  groupBy: UsageGroupBy | undefined,
): AliasableExpression<string | null> {
  switch (groupBy) {
    case undefined:
      return eb.cast<string | null>(eb.lit(null), "text");
    case "batch":
      // Its row's ID, which orders Batches by when they were created; its `id` names it after.
      return eb.cast<string>("usageRecord.batchUid", "text");
    case "key":
      return eb.ref("usageRecord.submitterKeyId");
    case "runner":
      return eb.ref("usageRecord.runnerId");
    case "status":
      return eb.cast<string>("usageRecord.status", "text");
    default:
      return eb
        .ref("usageRecord.labels", "->>")
        .key(groupBy.slice("label:".length))
        .$castTo<string | null>();
  }
}

/**
 * What names the group `groupKey`, as `groupOf` shows it: a Batch's `id`, a key's name as its
 * records hold it (`keyName`), and a Runner's name while the Runner exists, as a job shows it.
 */
function groupNameOf(
  groupBy: UsageGroupBy | undefined,
  groupKey: Expression<string | null>,
  keyName: Expression<string | null>,
): AliasableExpression<string | null> {
  const eb = expressionBuilder<Database>();
  switch (groupBy) {
    case "batch":
      return eb
        .selectFrom("batch as named")
        .select("named.id")
        .where("named.uid", "=", eb.cast<BatchUid>(groupKey, "uuid"))
        .$asScalar();
    case "key":
      return eb.cast<string | null>(keyName, "text");
    case "runner":
      return eb
        .selectFrom("runner as named")
        .select("named.name")
        .where("named.id", "=", eb.cast<RunnerId>(groupKey, "text"))
        .$asScalar();
    default:
      return eb.cast<string | null>(eb.lit(null), "text");
  }
}

/** `row`'s sums as the API's usage. */
function usageOf(row: { totalTokens: number; costUsd: number }): Usage {
  return { totalTokens: row.totalTokens, cost: { totalUsd: row.costUsd } };
}

/** The sums of `row`'s groups not named. */
function otherOf(row: { otherTotalTokens: number; otherCostUsd: number }) {
  return { totalTokens: row.otherTotalTokens, costUsd: row.otherCostUsd };
}

/** The group `row` as the API shows it, by `groupBy`. */
function groupOf(groupBy: UsageGroupBy, row: GroupRow): UsageGroup {
  const usage = usageOf(row);
  switch (groupBy) {
    case "batch":
      // A Batch is never deleted, so its row names it.
      return { batchId: z.parse(batchIdSchema, row.name), usage };
    case "key":
      return { key: { id: z.parse(z.string(), row.value), name: row.name }, usage };
    case "runner":
      return {
        runner:
          row.value === null
            ? null
            : { id: row.value, ...(row.name === null ? {} : { name: row.name }) },
        usage,
      };
    case "status":
      return { status: z.parse(finalJobStatusSchema, row.value), usage };
    default:
      return { labelValue: row.value, usage };
  }
}
