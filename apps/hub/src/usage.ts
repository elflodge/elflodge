import {
  batchIdSchema,
  finalJobStatusSchema,
  type Labels,
  MAX_USAGE_DAYS,
  submitterSchema,
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
  type QueryCreator,
  sql,
} from "kysely";
import { jsonArrayFrom, jsonBuildObject } from "kysely/helpers/postgres";
import * as z from "zod/mini";

import { requireRolePermission } from "./auth/auth.ts";
import { Db, greatest } from "./db/database.ts";
import type { BatchUid, Database, JobStatus, RunnerId, SubmitterKind } from "./db/types.ts";
import { InvalidInput } from "./invalid-input.ts";

// The Organization's usage, added up from its Usage records: each records what one job used up to
// one of its ends, since its previous end, and stays when the job is deleted. A record counts on
// the UTC day of the transaction that wrote it (`recordedAt`, ADR 0044).

/** What a read of usage asks for, beside its window. */
export interface UsageQuery {
  from?: string;
  to?: string;
  groupBy?: UsageGroupBy;
  /** With `groupBy`, how many groups to name; the rest are summed together. */
  limit: number;
  batchId?: string;
  /** Who submitted the jobs, by kind and ID. */
  submitter?: { kind: SubmitterKind; id: string };
  runnerId?: RunnerId;
  statuses: readonly JobStatus[];
  labels?: Labels;
}

/** How many days a read covers when it names no `from`. */
const DEFAULT_DAYS = 30;

/**
 * The first day a window may hold: Postgres reads no year 0000 in a date, as its calendar goes from
 * 1 BC to AD 1.
 */
const FIRST_DAY = DateTime.makeUnsafe("0001-01-01");

/**
 * The usage `query` asks for, read by the member signed in with `headers`, whose role must grant
 * reading it; a 403 error otherwise, and the window's problem when it is refused.
 */
export function readUsage(headers: Headers, query: UsageQuery) {
  return Effect.gen(function* () {
    yield* requireRolePermission(headers, { usage: ["read"] });
    const today = DateTime.startOf(yield* DateTime.now, "day");
    const window = yield* windowOf(query, today);
    const { groupBy } = query;
    if (groupBy === undefined) {
      const row = yield* Db.use((database) =>
        database.queryWithSignal((db, options) =>
          selectUsage(db, window, query).executeTakeFirstOrThrow(options),
        ),
      );
      return {
        from: window.from,
        to: window.to,
        usage: usageOf(row),
        days: row.days.map((day) => ({ date: day.day, usage: usageOf(day) })),
      } satisfies UsageReport;
    }
    const row = yield* Db.use((database) =>
      database.queryWithSignal((db, options) =>
        selectGroupedUsage(db, window, groupBy, query).executeTakeFirstOrThrow(options),
      ),
    );
    return {
      from: window.from,
      to: window.to,
      usage: usageOf(row),
      groups: row.groups.map((group) => groupOf(groupBy, group)),
      other: { groups: row.otherGroups, usage: usageOf(otherOf(row)) },
      days: row.days.map((day) => ({
        date: day.day,
        usage: usageOf(day),
        groups: day.groups.map((group) => groupOf(groupBy, group)),
        other: { usage: usageOf(otherOf(day)) },
      })),
    } satisfies UsageReport;
  });
}

/** A window of whole UTC days, from `from` to `to`, both included, as `YYYY-MM-DD`. */
interface Window {
  from: string;
  to: string;
}

/**
 * The window `query` asks for, by default the `DEFAULT_DAYS` days ending `today`, or the problem
 * with it, naming the field given: a day before `FIRST_DAY`, as when `to` puts the default
 * `from` there, a `from` after its `to`, or more than `MAX_USAGE_DAYS` days. The default
 * `from` is otherwise always within bounds, so the other problems are always the `from` given.
 */
function windowOf(query: Pick<UsageQuery, "from" | "to">, today: DateTime.Utc) {
  const to = query.to === undefined ? today : DateTime.makeUnsafe(query.to);
  const from =
    query.from === undefined
      ? DateTime.subtract(to, { days: DEFAULT_DAYS - 1 })
      : DateTime.makeUnsafe(query.from);
  const days = Duration.toDays(DateTime.distance(from, to)) + 1;
  const tooEarly = `Must be ${DateTime.formatIsoDateUtc(FIRST_DAY)} or later`;
  const problem =
    query.to !== undefined && DateTime.isLessThan(to, FIRST_DAY)
      ? { path: "to", message: tooEarly }
      : query.from === undefined && DateTime.isLessThan(from, FIRST_DAY)
        ? {
            path: "to",
            message: `Must be ${DateTime.formatIsoDateUtc(DateTime.add(FIRST_DAY, { days: DEFAULT_DAYS - 1 }))} or later without \`from\`, which is then ${DEFAULT_DAYS - 1} days before it`,
          }
        : DateTime.isLessThan(from, FIRST_DAY)
          ? { path: "from", message: tooEarly }
          : days < 1
            ? { path: "from", message: "Must not be after `to`" }
            : days > MAX_USAGE_DAYS
              ? {
                  path: "from",
                  message: `Must be at most ${MAX_USAGE_DAYS} days before \`to\`, counting both`,
                }
              : undefined;
  if (problem !== undefined) {
    const { path, message } = problem;
    return Effect.fail(new InvalidInput({ problems: [{ message, path: [path] }] }));
  }
  return Effect.succeed<Window>({
    from: DateTime.formatIsoDateUtc(from),
    to: DateTime.formatIsoDateUtc(to),
  });
}

/** The Usage records `query` asks for, those the hub wrote in `window`, to select from. */
function recordsOf(qb: QueryCreator<Database>, window: Window, query: UsageQuery) {
  let records = qb
    .selectFrom("usageRecord")
    .where("usageRecord.recordedAt", ">=", (eb) =>
      utcMidnightOf(eb, eb.cast(eb.val(window.from), "date")),
    )
    .where("usageRecord.recordedAt", "<", (eb) =>
      utcMidnightOf(eb, eb(eb.cast(eb.val(window.to), "date"), "+", eb.lit(1))),
    );
  const { statuses, labels, batchId, submitter, runnerId } = query;
  if (statuses.length > 0) {
    records = records.where("usageRecord.status", "=", (eb) => eb.fn.any(eb.val(statuses)));
  }
  if (labels !== undefined && Object.keys(labels).length > 0) {
    records = records.where((eb) =>
      eb("usageRecord.labels", "@>", eb.cast<Labels>(eb.val(labels), "jsonb")),
    );
  }
  if (batchId !== undefined) {
    records = records.where("usageRecord.batchUid", "=", (eb) =>
      eb.selectFrom("batch").select("batch.uid").where("batch.id", "=", batchId),
    );
  }
  if (submitter !== undefined) {
    records = records
      .where("usageRecord.submitterKind", "=", submitter.kind)
      .where("usageRecord.submitterId", "=", submitter.id);
  }
  if (runnerId !== undefined) records = records.where("usageRecord.runnerId", "=", runnerId);
  return records;
}

/**
 * The first instant of the UTC day `day`, worked out by Postgres from the calendar date: a
 * JavaScript `Date` would be sent in the local time zone, whose offset in some years had seconds
 * that node-postgres drops.
 */
function utcMidnightOf(eb: ExpressionBuilder<Database, "usageRecord">, day: Expression<unknown>) {
  return eb.fn<Date>("timezone", [eb.cast(eb.val("UTC"), "text"), eb.cast(day, "timestamp")]);
}

/** The UTC day a record counts on. */
function dayOf(eb: ExpressionBuilder<Database, "usageRecord">) {
  return eb
    .cast<Date>(
      eb.fn("timezone", [eb.cast(eb.val("UTC"), "text"), eb.ref("usageRecord.recordedAt")]),
      "date",
    )
    .as("day");
}

/** Every day of `window`, as `day`. */
function daysOf(qb: QueryCreator<Database>, window: Window) {
  return qb
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
    .select((eb) => eb.cast<Date>("series.series", "date").as("day"));
}

/**
 * The one statement that reads the usage `query` asks for over `window`, without groups: the
 * records' sums per day, and the window's. Added up as Postgres's exact `numeric` and `bigint`, not
 * in JavaScript.
 */
function selectUsage(db: Kysely<Database>, window: Window, query: UsageQuery) {
  return db
    .with("records", (qb) =>
      recordsOf(qb, window, query).select((eb) => [
        dayOf(eb),
        "usageRecord.totalTokens",
        "usageRecord.costUsd",
      ]),
    )
    .with("dayTotals", (qb) =>
      qb
        .selectFrom("records as r")
        .select((eb) => [
          "r.day",
          eb.cast<number>(eb.fn.sum("r.totalTokens"), "bigint").as("totalTokens"),
          eb.fn.sum<number>("r.costUsd").as("costUsd"),
        ])
        .groupBy("r.day"),
    )
    .with("days", (qb) => daysOf(qb, window))
    .selectFrom("dayTotals as dt")
    .select((eb) => [
      eb
        .cast<number>(eb.fn.coalesce(eb.fn.sum("dt.totalTokens"), eb.lit(0)), "bigint")
        .as("totalTokens"),
      eb.fn.coalesce(eb.fn.sum<number>("dt.costUsd"), eb.lit(0)).as("costUsd"),
      jsonArrayFrom(
        eb
          .selectFrom("days as d")
          .leftJoin("dayTotals as each", "each.day", "d.day")
          .select((day) => [
            "d.day",
            day.fn.coalesce("each.totalTokens", day.lit(0)).as("totalTokens"),
            day.fn.coalesce("each.costUsd", day.lit(0)).as("costUsd"),
          ])
          .orderBy("d.day"),
      ).as("days"),
    ]);
}

/**
 * The one statement that reads the usage `query` asks for over `window`, grouped by `groupBy`:
 * the records' sums per day and group (`cells`), one row per group ranked by its cost over the
 * window, then its tokens, then its key, which breaks every tie (`groups`), the top `limit` groups
 * named (`top`), and the window's and each day's sums, each day holding every top group, with the
 * rest summed as what the top groups leave of the day's total. Added up as Postgres's exact
 * `numeric` and `bigint`, not in JavaScript.
 */
function selectGroupedUsage(
  db: Kysely<Database>,
  window: Window,
  groupBy: UsageGroupBy,
  query: UsageQuery,
) {
  const { limit } = query;
  return (
    db
      .with("records", (qb) =>
        recordsOf(qb, window, query).select((eb) => [
          dayOf(eb),
          groupKeyOf(eb, groupBy).as("groupKey"),
          "usageRecord.recordedAt",
          "usageRecord.totalTokens",
          "usageRecord.costUsd",
        ]),
      )
      .with("cells", (qb) =>
        qb
          .selectFrom("records as r")
          .select((eb) => [
            "r.day",
            "r.groupKey",
            eb.cast<number>(eb.fn.sum("r.totalTokens"), "bigint").as("totalTokens"),
            eb.fn.sum<number>("r.costUsd").as("costUsd"),
            eb.fn.max("r.recordedAt").as("lastRecordedAt"),
          ])
          .groupBy(["r.day", "r.groupKey"]),
      )
      .with("groups", (qb) =>
        qb
          .selectFrom((sums) =>
            sums
              .selectFrom("cells as c")
              .select((eb) => [
                "c.groupKey",
                eb.cast<number>(eb.fn.sum("c.totalTokens"), "bigint").as("totalTokens"),
                eb.fn.sum<number>("c.costUsd").as("costUsd"),
                eb.fn.max("c.lastRecordedAt").as("lastRecordedAt"),
              ])
              .groupBy("c.groupKey")
              .as("g"),
          )
          .selectAll("g")
          .select((eb) =>
            eb.fn
              .agg<number>("row_number", [])
              .over((over) =>
                over
                  .orderBy("g.costUsd", "desc")
                  .orderBy("g.totalTokens", "desc")
                  .orderBy("g.groupKey", (order) => order.asc().nullsLast()),
              )
              .as("rank"),
          ),
      )
      // Named only now, so only the groups shown read a Batch or Runner.
      .with("top", (qb) =>
        qb
          .selectFrom("groups as g")
          .where("g.rank", "<=", limit)
          .select((eb) => [
            "g.rank",
            "g.groupKey",
            groupNameOf(
              groupBy,
              eb.ref("g.groupKey"),
              eb.ref("g.lastRecordedAt"),
              recordsOf(db, window, query),
            ).as("name"),
            "g.totalTokens",
            "g.costUsd",
          ]),
      )
      // Joined on the key and whether it is null, which Postgres can hash, unlike `is not distinct
      // from`, so the null group, such as records without the label, joins too.
      .with("topCells", (qb) =>
        qb
          .selectFrom("cells as c")
          .innerJoin("top as t", (join) =>
            join.on((eb) =>
              eb.and([
                eb(
                  eb.parens(eb("c.groupKey", "is", null)),
                  "=",
                  eb.parens(eb("t.groupKey", "is", null)),
                ),
                eb(
                  eb.fn.coalesce("c.groupKey", eb.val("")),
                  "=",
                  eb.fn.coalesce("t.groupKey", eb.val("")),
                ),
              ]),
            ),
          )
          .select(["c.day", "t.rank", "c.totalTokens", "c.costUsd"]),
      )
      .with("days", (qb) => daysOf(qb, window))
      .with("dayTotals", (qb) =>
        qb
          .selectFrom("cells as c")
          .select((eb) => [
            "c.day",
            eb.cast<number>(eb.fn.sum("c.totalTokens"), "bigint").as("totalTokens"),
            eb.fn.sum<number>("c.costUsd").as("costUsd"),
          ])
          .groupBy("c.day"),
      )
      .with("dayGroups", (qb) =>
        qb
          .selectFrom("days as d")
          .crossJoin("top as t")
          .leftJoin("topCells as tc", (join) =>
            join.onRef("tc.day", "=", "d.day").onRef("tc.rank", "=", "t.rank"),
          )
          .select((eb) => [
            "d.day",
            eb.fn
              .jsonAgg(
                jsonBuildObject({
                  value: eb.ref("t.groupKey"),
                  name: eb.ref("t.name"),
                  totalTokens: eb.fn.coalesce("tc.totalTokens", eb.lit(0)),
                  costUsd: eb.fn.coalesce("tc.costUsd", eb.lit(0)),
                }),
              )
              .orderBy("t.rank")
              .as("groups"),
            eb
              .cast<number>(eb.fn.coalesce(eb.fn.sum("tc.totalTokens"), eb.lit(0)), "bigint")
              .as("topTotalTokens"),
            eb.fn.coalesce(eb.fn.sum<number>("tc.costUsd"), eb.lit(0)).as("topCostUsd"),
          ])
          .groupBy("d.day"),
      )
      .selectFrom("dayTotals as dt")
      .select((eb) => {
        const totalTokens = eb.fn.coalesce(eb.fn.sum<number>("dt.totalTokens"), eb.lit(0));
        const costUsd = eb.fn.coalesce(eb.fn.sum<number>("dt.costUsd"), eb.lit(0));
        const top = eb.selectFrom("top as t");
        return [
          eb.cast<number>(totalTokens, "bigint").as("totalTokens"),
          costUsd.as("costUsd"),
          eb
            .cast<number>(
              eb(
                totalTokens,
                "-",
                top
                  .select((sum) =>
                    sum.fn.coalesce(sum.fn.sum<number>("t.totalTokens"), sum.lit(0)).as("sum"),
                  )
                  .$asScalar(),
              ),
              "bigint",
            )
            .as("otherTotalTokens"),
          eb(
            costUsd,
            "-",
            top
              .select((sum) =>
                sum.fn.coalesce(sum.fn.sum<number>("t.costUsd"), sum.lit(0)).as("sum"),
              )
              .$asScalar(),
          ).as("otherCostUsd"),
          eb
            .selectFrom("groups as g")
            .select((count) =>
              greatest(eb.lit(0), count(count.fn.max("g.rank"), "-", limit)).as("otherGroups"),
            )
            .$asScalar()
            .$notNull()
            .as("otherGroups"),
          jsonArrayFrom(
            top
              .select(["t.groupKey as value", "t.name", "t.totalTokens", "t.costUsd"])
              .orderBy("t.rank"),
          ).as("groups"),
          jsonArrayFrom(
            eb
              .selectFrom("days as d")
              .leftJoin("dayTotals as each", "each.day", "d.day")
              .leftJoin("dayGroups as dg", "dg.day", "d.day")
              .select((day) => {
                const dayTokens = day.fn.coalesce("each.totalTokens", day.lit(0));
                const dayCost = day.fn.coalesce("each.costUsd", day.lit(0));
                return [
                  "d.day",
                  dayTokens.as("totalTokens"),
                  dayCost.as("costUsd"),
                  day(dayTokens, "-", day.fn.coalesce("dg.topTotalTokens", day.lit(0))).as(
                    "otherTotalTokens",
                  ),
                  day(dayCost, "-", day.fn.coalesce("dg.topCostUsd", day.lit(0))).as(
                    "otherCostUsd",
                  ),
                  day.fn
                    .coalesce("dg.groups", day.cast<GroupRow[]>(day.val("[]"), "json"))
                    .as("groups"),
                ];
              })
              .orderBy("d.day"),
          ).as("days"),
        ];
      })
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
 * What groups a record, as text, by `groupBy`. A submitter is its kind and its ID, as
 * `key:<ID>` or `member:<ID>`, so that submitters of different kinds stay apart; the kind holds
 * no `:`.
 */
function groupKeyOf(
  eb: ExpressionBuilder<Database, "usageRecord">,
  groupBy: UsageGroupBy,
): AliasableExpression<string | null> {
  switch (groupBy) {
    case "batch":
      // Its row's ID, which orders Batches by when they were created; its `id` names it after.
      return eb.cast<string>("usageRecord.batchUid", "text");
    case "submitter":
      return eb(
        eb(eb.cast<string>("usageRecord.submitterKind", "text"), "||", eb.val(":")),
        "||",
        eb.ref("usageRecord.submitterId"),
      );
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
 * What names the group `groupKey`, as `groupOf` shows it: a Batch's `id`, a submitter's name as
 * its latest record of those read holds it, and a Runner's name while the Runner exists, as a job
 * shows it. The latest record is, of the `records` read, the group's last recorded, at
 * `lastRecordedAt`, and of those, the last written: an earlier transaction can write after a
 * later one, so the ID alone would not do.
 */
function groupNameOf(
  groupBy: UsageGroupBy,
  groupKey: Expression<string | null>,
  lastRecordedAt: Expression<Date>,
  records: ReturnType<typeof recordsOf>,
): AliasableExpression<string | null> {
  const eb = expressionBuilder<Database>();
  switch (groupBy) {
    case "batch":
      return eb
        .selectFrom("batch as named")
        .select("named.id")
        .where("named.uid", "=", eb.cast<BatchUid>(groupKey, "uuid"))
        .$asScalar();
    case "submitter":
      // Read for each group shown, by the index on `recordedAt`.
      return records
        .select("usageRecord.submitterName")
        .where("usageRecord.recordedAt", "=", lastRecordedAt)
        .where((named) => named(groupKeyOf(named, groupBy), "=", groupKey))
        .orderBy("usageRecord.id", "desc")
        .limit(1)
        .$asScalar();
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
    case "submitter": {
      const value = z.parse(z.string(), row.value);
      const kind = value.slice(0, value.indexOf(":"));
      const id = value.slice(kind.length + 1);
      return { submitter: z.parse(submitterSchema, { kind, id, name: row.name }), usage };
    }
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
