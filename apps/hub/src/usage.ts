import {
  batchIdSchema,
  finalJobStatusSchema,
  type Labels,
  MAX_USAGE_DAYS,
  submitterSchema,
  type UsageGroup,
  type UsageGroupBy,
  type UsageReport,
} from "contract";
import { DateTime, Duration, Effect } from "effect";
import {
  type AbortableQueryOptions,
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
import { Db } from "./db/database.ts";
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
 * The usage `query` asks for, read under the signed-in member's role. A role lacking the permission
 * gets a 403. An invalid window gets the problem with the window.
 */
export function readUsage(role: string, query: UsageQuery) {
  return Effect.gen(function* () {
    yield* requireRolePermission(role, { usage: ["read"] });
    const today = DateTime.startOf(yield* DateTime.now, "day");
    const window = yield* windowOf(query, today);
    return yield* Db.use((database) =>
      database.cancellableQuery((db, options) => selectUsage(db, window, query, options)),
    );
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
    records = records.where("usageRecord.labels", "@>", labels);
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

/** Tokens and cost as the API shows them, after Postgres has added them up. */
function usageOf(totalTokens: Expression<number>, totalUsd: Expression<number>) {
  return jsonBuildObject({ totalTokens, cost: jsonBuildObject({ totalUsd }) });
}

/** One statement, so the daily totals and the ranked groups count the same job ends. */
async function selectUsage(
  db: Kysely<Database>,
  window: Window,
  query: UsageQuery,
  options: AbortableQueryOptions,
): Promise<UsageReport> {
  const records = recordsOf(db, window, query);
  const grouping = query.groupBy === undefined ? undefined : groupingOf(query.groupBy, records);
  const report = db
    .with("records", () =>
      records.select((eb) => [
        dayOf(eb),
        "usageRecord.totalTokens",
        "usageRecord.costUsd",
        "usageRecord.recordedAt",
        (grouping?.key ?? eb.lit(null)).as("key"),
        grouping?.kind?.as("kind") ?? eb.lit(null).as("kind"),
      ]),
    )
    .with("dayTotals", (qb) =>
      qb
        .selectFrom("records")
        .groupBy("day")
        .select((eb) => [
          "day",
          eb.fn.countAll<number>().as("jobEnds"),
          eb.cast<number>(eb.fn.sum("totalTokens"), "bigint").as("totalTokens"),
          eb.fn.sum<number>("costUsd").as("costUsd"),
        ]),
    )
    .with("report", (qb) =>
      qb.selectFrom("dayTotals").select((eb) => [
        eb.cast<number>(eb.fn.coalesce(eb.fn.sum("jobEnds"), eb.lit(0)), "bigint").as("jobEnds"),
        usageOf(
          eb.cast<number>(eb.fn.coalesce(eb.fn.sum("totalTokens"), eb.lit(0)), "bigint"),
          eb.fn.coalesce(eb.fn.sum<number>("costUsd"), eb.lit(0)),
        ).as("usage"),
        jsonArrayFrom(
          eb
            .selectFrom(daysOf(qb, window).as("d"))
            .leftJoin("dayTotals as dt", "dt.day", "d.day")
            .select((day) => [
              "d.day as date",
              day.fn.coalesce("dt.jobEnds", day.lit(0)).as("jobEnds"),
              usageOf(
                day.fn.coalesce("dt.totalTokens", day.lit(0)),
                day.fn.coalesce("dt.costUsd", day.lit(0)),
              ).as("usage"),
            ])
            .orderBy("d.day"),
        ).as("days"),
      ]),
    );
  if (grouping === undefined) {
    const row = await report.selectFrom("report").selectAll().executeTakeFirstOrThrow(options);
    return { ...window, ...row };
  }
  const row = await report
    .with("groupTotals", (qb) =>
      qb
        .selectFrom("records")
        .groupBy(["kind", "key"])
        .select((eb) => [
          "kind",
          "key",
          eb.fn.max("recordedAt").as("lastRecordedAt"),
          eb.fn.countAll<number>().as("jobEnds"),
          eb.cast<number>(eb.fn.sum("totalTokens"), "bigint").as("totalTokens"),
          eb.fn.sum<number>("costUsd").as("costUsd"),
        ]),
    )
    .with("ranked", (qb) =>
      qb
        .selectFrom("groupTotals")
        .selectAll()
        .select((eb) =>
          eb.fn
            .agg<number>("row_number", [])
            .over((over) =>
              over
                .orderBy("costUsd", "desc")
                .orderBy("totalTokens", "desc")
                .orderBy("kind")
                .orderBy("key", (order) => order.asc().nullsLast()),
            )
            .as("rank"),
        ),
    )
    .selectFrom("report")
    .selectAll()
    .select((eb) => [
      jsonArrayFrom(
        eb
          .selectFrom("ranked as g")
          .where("g.rank", "<=", query.limit)
          .select((top) => [
            "g.key",
            "g.kind",
            "g.jobEnds",
            // Only groups shown need a Batch, Runner or submitter name.
            (
              grouping.name?.(top.ref("g.key"), top.ref("g.kind"), top.ref("g.lastRecordedAt")) ??
              top.lit(null)
            ).as("name"),
            usageOf(top.ref("g.totalTokens"), top.ref("g.costUsd")).as("usage"),
          ])
          .orderBy("g.rank"),
      ).as("groups"),
      eb
        .selectFrom("ranked as g")
        .where("g.rank", ">", query.limit)
        .select((rest) =>
          jsonBuildObject({
            groups: rest.fn.countAll<number>(),
            jobEnds: rest.cast<number>(
              rest.fn.coalesce(rest.fn.sum("g.jobEnds"), rest.lit(0)),
              "bigint",
            ),
            usage: usageOf(
              rest.cast<number>(
                rest.fn.coalesce(rest.fn.sum("g.totalTokens"), rest.lit(0)),
                "bigint",
              ),
              rest.fn.coalesce(rest.fn.sum<number>("g.costUsd"), rest.lit(0)),
            ),
          }).as("other"),
        )
        .$asScalar()
        .$notNull()
        .as("other"),
    ])
    .executeTakeFirstOrThrow(options);
  return {
    ...window,
    ...row,
    groups: row.groups.map(({ jobEnds, usage, ...identity }) =>
      grouping.display(identity, { jobEnds, usage }),
    ),
  };
}

/** The columns that identify a group and what the caller sees for that identity. */
interface Grouping {
  key: AliasableExpression<string | null>;
  kind?: AliasableExpression<SubmitterKind>;
  name?: (
    key: Expression<string | null>,
    kind: Expression<SubmitterKind | null>,
    lastRecordedAt: Expression<Date>,
  ) => AliasableExpression<string | null>;
  display: (
    row: {
      key: string | null;
      kind: SubmitterKind | null;
      name: string | null;
    },
    count: Pick<UsageGroup, "jobEnds" | "usage">,
  ) => UsageGroup;
}

function groupingOf(groupBy: UsageGroupBy, records: ReturnType<typeof recordsOf>): Grouping {
  const eb = expressionBuilder<Database, "usageRecord">();
  switch (groupBy) {
    case "batch":
      return {
        // The row's UUID orders Batches by creation. Its public ID names it.
        key: eb.ref("usageRecord.batchUid"),
        name: (key) =>
          eb
            .selectFrom("batch")
            .select("batch.id")
            .where("batch.uid", "=", eb.cast<BatchUid>(key, "uuid"))
            .$asScalar(),
        display: ({ name }, count) => ({ ...count, batchId: z.parse(batchIdSchema, name) }),
      };
    case "submitter":
      return {
        key: eb.ref("usageRecord.submitterId"),
        kind: eb.ref("usageRecord.submitterKind"),
        // An earlier transaction can write later. The record ID breaks ties in recordedAt.
        name: (key, kind, lastRecordedAt) =>
          records
            .select("usageRecord.submitterName")
            .where("usageRecord.recordedAt", "=", lastRecordedAt)
            .where((named) =>
              named.and([
                named(key, "=", named.ref("usageRecord.submitterId")),
                named(kind, "=", named.ref("usageRecord.submitterKind")),
              ]),
            )
            .orderBy("usageRecord.id", "desc")
            .limit(1)
            .$asScalar(),
        display: ({ key, kind, name }, count) => ({
          ...count,
          submitter: z.parse(submitterSchema, { kind, id: key, name }),
        }),
      };
    case "runner":
      return {
        key: eb.ref("usageRecord.runnerId"),
        name: (key) =>
          eb
            .selectFrom("runner")
            .select("runner.name")
            .where("runner.id", "=", eb.cast<RunnerId>(key, "text"))
            .$asScalar(),
        display: ({ key, name }, count) => ({
          ...count,
          runner: key === null ? null : { id: key, ...(name === null ? {} : { name }) },
        }),
      };
    case "status":
      return {
        key: eb.cast<string>("usageRecord.status", "text"),
        display: ({ key }, count) => ({ ...count, status: z.parse(finalJobStatusSchema, key) }),
      };
    default:
      return {
        key: eb
          .ref("usageRecord.labels", "->>")
          .key(groupBy.slice("label:".length))
          .$castTo<string | null>(),
        display: ({ key }, count) => ({ ...count, labelValue: key }),
      };
  }
}
