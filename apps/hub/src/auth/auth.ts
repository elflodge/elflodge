import { ORPCError, type ORPCErrorCode } from "@orpc/server";
import { betterAuth } from "better-auth";
import { isAPIError } from "better-auth/api";
import { type Access, errorCodeOf, Forbidden, HubNotSetUp, Unauthorized } from "contract";
import { Cause, Context, Effect, Layer } from "effect";
import ensureError from "ensure-error";
import { type InflightQueryAbortStrategy, type Kysely, sql } from "kysely";
import * as z from "zod/mini";

import { Db, openScopedDatabase } from "../db/database.ts";
import { type Database, UserId } from "../db/types.ts";
import { authOptions, type AuthSettings } from "./options.ts";

/** A Better Auth instance with the hub's options. */
type BetterAuth = ReturnType<typeof betterAuth<ReturnType<typeof authOptions>>>;

/** Better Auth on the hub's database. */
export class Auth extends Context.Service<
  Auth,
  {
    /**
     * Calls Better Auth. Its refusals become oRPC's errors (`fromBetterAuth`).
     */
    readonly call: <A>(
      run: (betterAuth: BetterAuth) => Promise<A>,
    ) => Effect.Effect<A, ORPCError<ORPCErrorCode, unknown> | Cause.UnknownError>;
  }
>()("hub/Auth", {
  /** Better Auth for the hub, on the database `db`. */
  make: (db: Kysely<Database>, settings: Omit<AuthSettings, "db">) =>
    Effect.sync(() => {
      const instance = betterAuth(authOptions({ ...settings, db }));
      return {
        call: (run) => Effect.tryPromise({ try: () => run(instance), catch: fromBetterAuth }),
      };
    }),
}) {}

/**
 * Preserve a Better Auth refusal's HTTP status and message. The contract uses the status number
 * as the error code when oRPC has no name for it.
 */
export function fromBetterAuth(caught: unknown) {
  const error = ensureError(caught);
  return isAPIError(error)
    ? new ORPCError(errorCodeOf(error.statusCode), { message: error.body?.message })
    : new Cause.UnknownError(error);
}

/**
 * The hub's database and Better Auth on it, for the Layer's lifetime. On Workers the Layer is built
 * per request, as a connection may serve only the request that opened it, and Better Auth's lazy
 * initialization can wait forever after a cancelled request leaves its promise unsettled
 * (better-auth/better-auth#10315).
 */
export function databaseAndAuthLayer(
  connectionString: string,
  settings: Omit<AuthSettings, "db">,
  inflightQueryAbortStrategy?: InflightQueryAbortStrategy,
) {
  return Layer.effectContext(
    Effect.gen(function* () {
      const db = yield* openScopedDatabase(connectionString);
      return Context.make(Db, yield* Db.make(db, inflightQueryAbortStrategy)).pipe(
        Context.add(Auth, yield* Auth.make(db, settings)),
      );
    }),
  );
}

/**
 * The deployment's Organization (ADR 0007), which owns every member and key, or `undefined` before
 * the hub is set up. There is only one, so the first row is it.
 * Better Auth lists a signed-in user's Organizations. This lookup also runs without a session.
 */
export async function findOrganization(db: Kysely<Database>) {
  return await db.selectFrom("organization").select("id").executeTakeFirst();
}

/** The deployment's Organization, or a 503 error before the hub is set up. */
export const getOrganization = Effect.gen(function* () {
  const database = yield* Db;
  const organization = yield* database.query(findOrganization);
  if (!organization) {
    return yield* Effect.fail(new HubNotSetUp());
  }
  return organization;
});

/**
 * The signed-in member making the request: a 401 error without a session, and a 403 error for an
 * account that is not a member of the Organization. Removing a member leaves their session, so the
 * session alone does not make its user a member. The user comes with their ID branded.
 */
function requireMember(headers: Headers) {
  return Effect.gen(function* () {
    const auth = yield* Auth;
    const session = yield* auth.call((instance) => instance.api.getSession({ headers }));
    if (!session) return yield* Effect.fail(new Unauthorized());
    // The ID enters the hub here.
    const userId = UserId(session.user.id);
    // getSession plus this statement takes three reads per member call and distinguishes 401,
    // 403 and 503. The statement reads the Organization and membership from one snapshot.
    // getActiveMemberRole returns only the role, so the hub still needs getSession for the user, at
    // seven reads in total.
    const organization = yield* Db.use((database) =>
      database.query((db) =>
        db
          .selectFrom("organization")
          .select((eb) =>
            eb
              .exists(
                eb
                  .selectFrom("member")
                  .select("member.id")
                  .whereRef("member.organizationId", "=", "organization.id")
                  .where("member.userId", "=", userId),
              )
              .as("isMember"),
          )
          .executeTakeFirst(),
      ),
    );
    // An account without the Organization is an owner left by a setup that stopped halfway in
    // 0.10.0 or earlier, before setup became one transaction: the hub is not set up for them.
    if (!organization) return yield* Effect.fail(new HubNotSetUp());
    if (!organization.isMember) {
      return yield* Effect.fail(
        new Forbidden({ message: "This account is not a member of the Organization" }),
      );
    }
    return { ...session.user, id: userId };
  });
}

/**
 * The API key sent in `x-api-key`, verified to hold `permissions`, or a 401 error. Better Auth answers
 * a key lacking the permissions as it answers an unknown key, so the answer reveals nothing about it.
 */
export function requireKey(headers: Headers, permissions: Record<string, string[]>) {
  return Effect.gen(function* () {
    const key = headers.get("x-api-key");
    if (!key) return yield* Effect.fail(new Unauthorized());
    const auth = yield* Auth;
    const result = yield* auth.call((instance) =>
      instance.api.verifyApiKey({ body: { key, permissions } }),
    );
    if (!result.valid || !result.key) {
      // Better Auth answers a key it could not check, such as while the database is unreachable, as
      // it answers an unknown key. Only a hub that reaches its database calls a key unknown;
      // otherwise the call fails as one the hub could not serve, and its caller may retry. Drop
      // this probe once better-auth/better-auth#11665 ships, which makes such a check fail; the
      // Runner's upgrade (`authenticateRunner`) must then answer that failure, an
      // `INTERNAL_SERVER_ERROR` here, with its 503.
      yield* Db.use((database) => database.query((db) => sql`select 1`.execute(db)));
      return yield* Effect.fail(new Unauthorized());
    }
    return result.key;
  });
}

/**
 * Fails with a 403 error unless the role of the member signed in with `headers` grants
 * `permissions`, as Better Auth decides it from the Organization's roles.
 */
export function requireRolePermission(headers: Headers, permissions: RolePermissions) {
  return Effect.gen(function* () {
    const auth = yield* Auth;
    const { id: organizationId } = yield* getOrganization;
    const { success } = yield* auth.call((instance) =>
      instance.api.hasPermission({ headers, body: { organizationId, permissions } }),
    );
    if (!success) yield* Effect.fail(new Forbidden());
  });
}

/** Permissions a member's role may grant, as Better Auth's check of a role takes them. */
type RolePermissions = NonNullable<
  NonNullable<Parameters<BetterAuth["api"]["hasPermission"]>[0]>["body"]["permissions"]
>;

/**
 * What the hub records in the metadata of a key a member creates: the member, whom Better Auth does
 * not keep for an Organization's key. Better Auth types metadata as any object, so the hub checks it.
 */
export const keyMetadataSchema = z.object({ createdBy: z.string() });
export type KeyMetadata = z.infer<typeof keyMetadataSchema>;

/**
 * Who made a call: the API key it was sent with, as Better Auth verified it, the member, or anyone,
 * unidentified, for a call open to anyone.
 */
export type Caller =
  | { kind: "key"; key: Effect.Success<ReturnType<typeof requireKey>> }
  | { kind: "member"; member: Effect.Success<ReturnType<typeof requireMember>> }
  | { kind: "anyone" };

/**
 * The caller `headers` identify, as `access` allows: the API key sent in `x-api-key`, verified to
 * hold `access.key`, whenever a key is accepted and one is sent; else the signed-in member, where a
 * member is accepted; else anyone, where anyone is accepted; else a 401 error.
 */
export function authenticate(headers: Headers, access: Access) {
  if (access.key && headers.has("x-api-key")) {
    return requireKey(headers, access.key).pipe(
      Effect.map((key): Caller => ({ kind: "key", key })),
    );
  }
  if (access.member) {
    return requireMember(headers).pipe(
      Effect.map((member): Caller => ({ kind: "member", member })),
    );
  }
  if (access.anyone) return Effect.succeed<Caller>({ kind: "anyone" });
  return Effect.fail(new Unauthorized());
}

/** The key that made a call the contract declares as by key; a member there is a hub defect. */
export function callerKey(caller: Caller) {
  return caller.kind === "key"
    ? Effect.succeed(caller.key)
    : Effect.die(new Error(`A call the contract declares as by key was made by ${caller.kind}`));
}

/** The member who made a call the contract declares as by member; a key there is a hub defect. */
export function callerMember(caller: Caller) {
  return caller.kind === "member"
    ? Effect.succeed(caller.member)
    : Effect.die(new Error(`A call the contract declares as by member was made by ${caller.kind}`));
}
