import { safeJSONParse } from "better-auth";
import type { ApiKey } from "contract";
import { Effect } from "effect";
import { jsonObjectFrom } from "kysely/helpers/postgres";

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
        .select(["id", "name", "start", "permissions", "createdAt", "expiresAt"])
        .select((outer) =>
          jsonObjectFrom(
            outer
              .selectFrom("user")
              .where("user.id", "=", (eb) =>
                eb.fn<UserId>("jsonb_extract_path_text", [
                  eb.cast("apikey.metadata", "jsonb"),
                  eb.val("createdBy"),
                ]),
              )
              .select(["user.id", "user.name"])
              .select((eb) =>
                eb
                  .exists(
                    eb
                      .selectFrom("member")
                      .select("member.id")
                      .whereRef("member.userId", "=", "user.id")
                      .whereRef("member.organizationId", "=", "apikey.referenceId"),
                  )
                  .$castTo<boolean>()
                  .as("isMember"),
              ),
          ).as("creator"),
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
