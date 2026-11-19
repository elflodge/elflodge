import { safeJSONParse } from "better-auth";
import type { ApiKey } from "contract";
import { Effect } from "effect";

import { requireRolePermission } from "./auth/auth.ts";
import { API_KEY_CONFIG } from "./auth/options.ts";
import { Db } from "./db/database.ts";
import type { OrganizationId } from "./db/types.ts";

export function listApiKeys(organizationId: OrganizationId, role: string) {
  return Effect.gen(function* () {
    yield* requireRolePermission(role, { apiKey: ["read"] });
    const database = yield* Db;
    return yield* database.query(async (db): Promise<ApiKey[]> => {
      // Better Auth's listApiKeys reads at most 100 Organization keys before filtering, so paging
      // cannot reach the rest. Use it again when it filters and pages in the database query.
      // The hub never disables a key, so this read needs no enabled filter.
      const keys = await db
        .selectFrom("apikey")
        .select(["id", "name", "start", "permissions", "createdAt", "expiresAt"])
        .where("referenceId", "=", organizationId)
        .where("configId", "=", API_KEY_CONFIG)
        .where((eb) => eb.or([eb("expiresAt", "is", null), eb("expiresAt", ">=", new Date())]))
        .execute();
      return keys.map((key) => ({
        ...key,
        permissions: key.permissions ? safeJSONParse<ApiKey["permissions"]>(key.permissions) : null,
      }));
    });
  });
}
