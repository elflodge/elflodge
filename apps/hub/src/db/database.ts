import { type Cause, Context, Duration, Effect, Layer } from "effect";
import ensureError from "ensure-error";
import {
  type AbortableQueryOptions,
  type Expression,
  type ExpressionBuilder,
  type InflightQueryAbortStrategy,
  Kysely,
  PostgresDialect,
  type RawBuilder,
  sql,
} from "kysely";
import { Pool, TypeOverrides, types } from "pg";

import type { Database } from "./types.ts";

/**
 * The Postgres schema holding the hub's tables. The hub may share a database with other software, so
 * it keeps to its own schema, and every statement names it: Hyperdrive resets `search_path` after
 * each transaction.
 */
export const DB_SCHEMA = "elflodge";

/**
 * A set of rows from the caller, as one JSON parameter the statement expands, however many rows
 * there are: each row's scalar fields are read with `->>` and cast to their types where the clause
 * selects them, and its JSON values are read with `->`. `->` gives SQL null only for a key the row
 * leaves out, so a JSON value that is absent is left out rather than null.
 */
export function jsonRows<Row extends object>(eb: ExpressionBuilder<Database, never>, rows: Row[]) {
  return eb
    .fn<{ value: Row }>("jsonb_array_elements", [eb.cast(eb.val(JSON.stringify(rows)), "jsonb")])
    .as("row");
}

/**
 * `at` plus `duration`, as Postgres adds an `interval` to a `timestamptz`, null when `at` is:
 * Kysely has no `interval` type, and types `+` only between operands of one type.
 */
export function plusDuration<T extends Date | null>(
  at: Expression<T>,
  duration: Duration.Duration,
): RawBuilder<T> {
  return sql<T>`${at} + make_interval(secs => ${Duration.toSeconds(duration)})`;
}

/**
 * The greatest of `values`, as Postgres's `greatest`, which skips nulls: null only when every
 * value is, so not null when the first is not. Kysely's `eb.fn` would take the result's type on
 * trust and let the values' types differ.
 */
export function greatest<T>(first: Expression<T>, ...rest: Expression<T | null>[]): RawBuilder<T>;
export function greatest<T>(...values: Expression<T | null>[]): RawBuilder<T | null>;
export function greatest<T>(...values: Expression<T | null>[]): RawBuilder<T | null> {
  return sql<T | null>`greatest(${sql.join(values)})`;
}

/** The hub's database. */
export class Db extends Context.Service<
  Db,
  {
    /** Runs one Kysely call on the hub's database, naming its schema in every statement. */
    readonly query: <A>(
      run: (db: Kysely<Database>, options: AbortableQueryOptions) => Promise<A>,
    ) => Effect.Effect<A, Cause.UnknownError>;
  }
>()("hub/Db", {
  /** The service on `db`, a Kysely instance that does not name the schema itself. */
  make: (db: Kysely<Database>, inflightQueryAbortStrategy?: InflightQueryAbortStrategy) => {
    const inSchema = db.withSchema(DB_SCHEMA);
    return Effect.succeed({
      query: (run) =>
        Effect.tryPromise((signal) => run(inSchema, { signal, inflightQueryAbortStrategy })),
    });
  },
}) {}

/**
 * Opens a Kysely instance on the hub's database without naming the schema, for Better Auth, which
 * names it itself. Close it with `destroy()`, or declare it with `await using`.
 */
export function openDatabase(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: openPool(connectionString) }),
  });
}

/**
 * How the hub reads Postgres values: as pg does, except that an `int8`, such as a count or a sum of
 * integers, becomes a number, as pg-types' README suggests, and one beyond `Number.MAX_SAFE_INTEGER`
 * fails its query instead of being rounded; and a `numeric`, such as a cost, becomes the nearest
 * number, as pg-types reads an array of them, since the API carries money as a number.
 */
const typeParsers = new TypeOverrides();
typeParsers.setTypeParser(types.builtins.INT8, (text) => {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`The int8 ${text} is beyond what a JavaScript number holds exactly`);
  }
  return value;
});
typeParsers.setTypeParser(types.builtins.NUMERIC, parseFloat);

/**
 * A connection pool to the hub's database. An idle connection that fails, as when Postgres restarts,
 * is reported on the pool; without a listener Node would end the process. The pool drops that
 * connection, and the next query opens a new one.
 */
export function openPool(connectionString: string): Pool {
  const pool = new Pool({ connectionString, types: typeParsers });
  pool.on("error", (error) => {
    console.error("A database connection failed:", ensureError(error).message);
  });
  return pool;
}

/** Opens a Kysely instance on the hub's database for the scope, closing its connections with it. */
export function openScopedDatabase(connectionString: string) {
  return Effect.acquireRelease(
    Effect.sync(() => openDatabase(connectionString)),
    (db) => Effect.promise(() => db.destroy()),
  );
}

/**
 * The hub's database for a Layer's lifetime. Workers forbid using a connection in any request but
 * the one that opened it, so there the Layer is built per request; Hyperdrive pools the real
 * connections to Postgres.
 */
export function databaseLayer(connectionString: string) {
  return Layer.effect(Db, Effect.flatMap(openScopedDatabase(connectionString), Db.make));
}
