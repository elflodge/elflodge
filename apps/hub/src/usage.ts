import {
  type Labels,
  MAX_USAGE_DAYS,
  usageGroupsSchema,
  type UsageGroupBy,
  type UsageReport,
} from "contract";
import { DateTime, Duration, Effect } from "effect";
import {
  type AbortableQueryOptions,
  type Expression,
  type ExpressionBuilder,
  expressionBuilder,
  type Kysely,
  type QueryCreator,
  type Selectable,
  sql,
} from "kysely";
import { jsonArrayFrom, jsonBuildObject } from "kysely/helpers/postgres";
import * as z from "zod/mini";

import { requireRolePermission } from "./auth/auth.ts";
import { Db } from "./db/database.ts";
import type { Database, JobStatus, RunnerId, SubmitterKind } from "./db/types.ts";
import { InvalidInput } from "./invalid-input.ts";
import { batchIdOf } from "./jobs.ts";

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

/** Each Usage record is one job end, even when it used no tokens. */
function recordCounts(tokens: Expression<number>, cost: Expression<number>) {
  const eb = expressionBuilder();
  return [
    eb.fn.countAll<number>().as("jobEnds"),
    eb.cast<number>(eb.fn.sum(tokens), "bigint").as("totalTokens"),
    eb.fn.sum<number>(cost).as("costUsd"),
  ];
}

/** The window and its remainder both sum counts, with zeros for an empty set. */
function sumCounts(ends: Expression<number>, tokens: Expression<number>, cost: Expression<number>) {
  const eb = expressionBuilder();
  const sum = (value: Expression<number>) => eb.fn.coalesce(eb.fn.sum<number>(value), eb.lit(0));
  return {
    jobEnds: eb.cast<number>(sum(ends), "bigint"),
    usage: usageOf(eb.cast<number>(sum(tokens), "bigint"), sum(cost)),
  };
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
        ...(grouping?.recordFields ?? []),
      ]),
    )
    .with("dayTotals", (qb) =>
      qb
        .selectFrom("records")
        .groupBy("day")
        .select((eb) => ["day", ...recordCounts(eb.ref("totalTokens"), eb.ref("costUsd"))]),
    )
    .with("report", (qb) =>
      qb.selectFrom("dayTotals").select((eb) => {
        const totals = sumCounts(eb.ref("jobEnds"), eb.ref("totalTokens"), eb.ref("costUsd"));
        return [
          totals.jobEnds.as("jobEnds"),
          totals.usage.as("usage"),
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
        ];
      }),
    );
  if (grouping === undefined) {
    const row = await report.selectFrom("report").selectAll().executeTakeFirstOrThrow(options);
    return { ...window, ...row };
  }
  const row = await report
    .with("groupTotals", (qb) =>
      qb
        .selectFrom("records")
        .groupBy(grouping.keys)
        .select(grouping.keys)
        .select((eb) => recordCounts(eb.ref("totalTokens"), eb.ref("costUsd")))
        .select((eb) => grouping.aggregate?.(eb.ref("recordedAt")) ?? []),
    )
    .with("ranked", (qb) =>
      qb
        .selectFrom("groupTotals")
        .selectAll()
        .select((eb) =>
          eb.fn
            .agg<number>("row_number", [])
            .over((over) =>
              grouping.keys.reduce(
                (order, key) => order.orderBy(key),
                over.orderBy("costUsd", "desc").orderBy("totalTokens", "desc"),
              ),
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
            "g.jobEnds",
            // Only groups shown need a Batch, Runner or submitter name.
            grouping.publicField,
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
            ...sumCounts(rest.ref("g.jobEnds"), rest.ref("g.totalTokens"), rest.ref("g.costUsd")),
          }).as("other"),
        )
        .$asScalar()
        .as("other"),
    ])
    .executeTakeFirstOrThrow(options);
  return {
    ...window,
    ...row,
    // SQL widens the status to text and the submitter name to nullable for both kinds.
    groups: z.parse(usageGroupsSchema, row.groups),
  };
}

/**
 * The columns of the ranked groups, as `g`, written out so each grouping can build its public
 * field where it is declared. Passing the ranked columns in instead would check each name, but
 * every grouping would take all of them; the grouping's own query, which each test runs, catches a
 * column this grouping does not rank.
 */
type GroupIdentity = Pick<
  Selectable<Database["usageRecord"]>,
  "batchUid" | "runnerId" | "submitterKind" | "submitterId" | "recordedAt"
> & { status: string; labelValue: string | null };

/**
 * Keeps each grouping's parts together: its keys, the record fields they are read from, any extra
 * aggregate and the public field built from them.
 */
function groupingOf(groupBy: UsageGroupBy, records: ReturnType<typeof recordsOf>) {
  const record = expressionBuilder<Database, "usageRecord">();
  const top = expressionBuilder<Database & { g: GroupIdentity }, "g">();
  switch (groupBy) {
    case "batch": {
      // The UUIDv7 breaks ties in Batch creation order (ADR 0036).
      const keys = ["batchUid"] as const;
      // A Batch is never deleted, so its row names it.
      return {
        keys,
        recordFields: keys,
        publicField: batchIdOf(top.ref("g.batchUid")).as("batchId"),
      };
    }
    case "submitter": {
      const keys = ["submitterKind", "submitterId"] as const;
      // An older transaction can write a higher ID. Choose the latest recordedAt first, then
      // the highest record ID among ends recorded at that time.
      const name = records
        .select("usageRecord.submitterName")
        .whereRef("usageRecord.recordedAt", "=", top.ref("g.recordedAt"))
        .whereRef("usageRecord.submitterKind", "=", top.ref("g.submitterKind"))
        .whereRef("usageRecord.submitterId", "=", top.ref("g.submitterId"))
        .orderBy("usageRecord.id", "desc")
        .limit(1)
        .$asScalar();
      return {
        keys,
        recordFields: [...keys, "recordedAt"] as const,
        // There is no submitter index. Taking the maximum while grouping avoids searching the
        // window again for each top submitter and lets the name lookup use the recordedAt index.
        aggregate: (recordedAt: Expression<Date>) => [
          expressionBuilder().fn.max(recordedAt).as("recordedAt"),
        ],
        publicField: jsonBuildObject({
          kind: top.ref("g.submitterKind"),
          id: top.ref("g.submitterId"),
          name,
        }).as("submitter"),
      };
    }
    case "runner": {
      const keys = ["runnerId"] as const;
      const id = top.ref("g.runnerId");
      const name = top
        .selectFrom("runner")
        .select("runner.name")
        .whereRef("runner.id", "=", id)
        .$asScalar();
      return {
        keys,
        recordFields: keys,
        publicField: top
          .case()
          .when(id, "is", null)
          .then(top.lit(null))
          .else(top.fn("json_strip_nulls", [jsonBuildObject({ id, name })]))
          .end()
          .as("runner"),
      };
    }
    case "status": {
      const keys = ["status"] as const;
      // Equal-cost, equal-token statuses sort by their API spelling.
      return {
        keys,
        recordFields: [record.cast<string>("usageRecord.status", "text").as("status")],
        publicField: top.ref("g.status").as("status"),
      };
    }
    default:
      return {
        keys: ["labelValue"] as const,
        recordFields: [
          record
            .ref("usageRecord.labels", "->>")
            .key(groupBy.slice("label:".length))
            .as("labelValue"),
        ],
        publicField: top.ref("g.labelValue").as("labelValue"),
      };
  }
}
