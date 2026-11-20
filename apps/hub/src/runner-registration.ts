import { NotFound } from "contract";
import { Effect, Predicate } from "effect";

import { Auth, requireRolePermission } from "./auth/auth.ts";
import { RUNNER_KEY_CONFIG, RUNNER_KEY_ROLE } from "./auth/options.ts";
import { Db, storedRoles } from "./db/database.ts";
import { ApikeyId, type OrganizationId, RunnerId } from "./db/types.ts";
import { deleteRunnerWithItsWork } from "./jobs.ts";

// A Runner starts with a key shared by many Runners and registers once, receiving a key of its own
// that it keeps and connects with, as GitHub Actions and Buildkite runners do. The hub records which
// key belongs to which Runner and looks the Runner up by the key, so one Runner cannot connect as
// another. The link is the key's ID in the Runner's row, which the database deletes with the key.

/** Registers a Runner named `name`, returning its ID and its own key. */
export function registerRunner(organizationId: OrganizationId, name: string) {
  return Effect.gen(function* () {
    const database = yield* Db;
    const auth = yield* Auth;
    // Better Auth creates an organization's key on behalf of a member allowed to; the owner always is.
    const owner = yield* database.query((db) =>
      db
        .selectFrom("member")
        .select("userId")
        .where("organizationId", "=", organizationId)
        .where((eb) => eb(eb.val("owner"), "=", eb.fn.any(storedRoles(eb.ref("role")))))
        .limit(1)
        .executeTakeFirstOrThrow(),
    );
    const runnerId = RunnerId(crypto.randomUUID());
    // The key first: the Runner's row references it.
    const key = yield* auth.call((betterAuth) =>
      betterAuth.api.createApiKey({
        body: {
          configId: RUNNER_KEY_CONFIG,
          organizationId,
          userId: owner.userId,
          name: "Runner",
          permissions: { runner: [...RUNNER_KEY_ROLE.statements.runner] },
        },
      }),
    );
    yield* database.query((db) =>
      db
        .insertInto("runner")
        .values({ id: runnerId, name, lastSeenAt: new Date(), keyId: ApikeyId(key.id) })
        .execute(),
    );
    return { id: runnerId, key: key.key };
  });
}

/** The Runner whose own key has the ID `keyId`, if any. */
export function findRunnerByKey(keyId: ApikeyId) {
  return Db.use((database) =>
    database.query((db) =>
      db.selectFrom("runner").select("id").where("keyId", "=", keyId).executeTakeFirst(),
    ),
  ).pipe(Effect.map((runner) => runner?.id));
}

/**
 * Removes the Runner when the member's role grants permission to delete Organization keys. Only
 * Better Auth's deleteApiKey call needs the session headers. The Runner's row goes
 * first, in one transaction with the work it held, so nothing leaves the Runner gone with its
 * jobs unended. Its key goes after, through Better Auth: the hub refuses a key whose Runner's row is
 * gone, so a key a failure leaves behind grants nothing, and retention's sweep removes it.
 * Returns the jobs the removal concerns. The caller drops the Runner's connection. Every way the hub
 * deletes a Runner's key comes here: Better Auth's own key routes are disabled for this reason.
 */
export function removeRunner(headers: Headers, role: string, runnerId: RunnerId) {
  return Effect.gen(function* () {
    yield* requireRolePermission(role, { apiKey: ["delete"] });
    const auth = yield* Auth;
    const removed = yield* deleteRunnerWithItsWork(runnerId).pipe(
      Effect.filterOrFail(Predicate.isNotUndefined, () => new NotFound()),
    );
    yield* auth
      .call((betterAuth) =>
        betterAuth.api.deleteApiKey({
          headers,
          body: { keyId: removed.keyId, configId: RUNNER_KEY_CONFIG },
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => console.error("Deleting a removed Runner's key failed", cause)),
        ),
      );
    return { endedJobs: removed.endedJobs, jobsWithFilesLeft: removed.jobsWithFilesLeft };
  });
}
