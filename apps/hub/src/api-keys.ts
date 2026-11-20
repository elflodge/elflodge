import { safeJSONParse } from "better-auth";
import type { ApiKey } from "contract";
import { Effect } from "effect";
import { jsonBuildObject } from "kysely/helpers/postgres";

import { requireRolePermission } from "./auth/auth.ts";
import { API_KEY_CONFIG } from "./auth/options.ts";
import { Db } from "./db/database.ts";
import type { OrganizationId, UserId } from "./db/types.ts";

/** Lists the Organization's unexpired API keys. A member whose role lacks apiKey:read gets a 403. */
export function listServiceKeys(organizationId: OrganizationId, role: string) {
  return Effect.gen(function* () {
    yield* requireRolePermission(role, { apiKey: ["read"] });
    const database = yield* Db;
    return yield* database.query(async (db): Promise<ApiKey[]> => {
      // Better Auth's listApiKeys reads at most the adapter's default 100 Organization keys,
      // Runner keys included, before filtering by configuration. Keys beyond those rows go missing.
      // Use it again when it filters by configuration and pages in the query, provided it or the
      // hub excludes expired keys so the list is the same before and after Better Auth's sweep.
      // The hub never disables a key, so this read needs no enabled filter.
      const keys = await db
        .selectFrom("apikey")
        .leftJoin("user as creator", (join) =>
          join.on((eb) =>
            eb(
              "creator.id",
              "=",
              eb.fn<UserId>("jsonb_extract_path_text", [
                eb.cast("apikey.metadata", "jsonb"),
                eb.val("createdBy"),
              ]),
            ),
          ),
        )
        .select([
          "apikey.id",
          "apikey.name",
          "apikey.start",
          "apikey.permissions",
          "apikey.createdAt",
          "apikey.expiresAt",
        ])
        .select((eb) =>
          eb
            .case()
            .when("creator.id", "is", null)
            .then(null)
            .else(
              jsonBuildObject({
                id: eb.ref("creator.id").$notNull(),
                name: eb.ref("creator.name").$notNull(),
                isMember: eb
                  .exists(
                    eb
                      .selectFrom("member")
                      .select("member.id")
                      .whereRef("member.userId", "=", "creator.id")
                      .whereRef("member.organizationId", "=", "apikey.referenceId"),
                  )
                  .$castTo<boolean>(),
              }),
            )
            .end()
            .as("creator"),
        )
        .where("referenceId", "=", organizationId)
        .where("configId", "=", API_KEY_CONFIG)
        .where((eb) => eb.or([eb("expiresAt", "is", null), eb("expiresAt", ">=", new Date())]))
        .execute();
      return keys.map((key) => ({
        ...key,
        permissions: safeJSONParse<ApiKey["permissions"]>(key.permissions),
      }));
    });
  });
}
