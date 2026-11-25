import { InvitationUnavailable } from "contract";
import { Effect, Predicate } from "effect";
import { jsonBuildObject } from "kysely/helpers/postgres";

import { requireRolePermission } from "./auth/auth.ts";
import { liveInvitations, mayGrantRole } from "./auth/invitation-grants.ts";
import { Db } from "./db/database.ts";
import type { InvitationId, OrganizationId } from "./db/types.ts";

export function previewInvitation(id: InvitationId) {
  return Db.use((database) =>
    database.query((db) =>
      liveInvitations(db)
        .innerJoin("organization", "organization.id", "invitation.organizationId")
        .where("invitation.id", "=", id)
        .select([
          "invitation.email",
          "invitation.role",
          "invitation.expiresAt",
          "organization.name as organizationName",
        ])
        .$narrowType<{ role: string }>()
        .executeTakeFirst(),
    ),
  ).pipe(Effect.filterOrFail(Predicate.isNotUndefined, () => new InvitationUnavailable()));
}

export function listInvitations(organizationId: OrganizationId, role: string) {
  return Effect.gen(function* () {
    yield* requireRolePermission(role, { invitation: ["create"] });
    return yield* Db.use((database) =>
      database.query((db) =>
        liveInvitations(db)
          .innerJoin("user", "user.id", "invitation.inviterId")
          .where("invitation.organizationId", "=", organizationId)
          .where((eb) => mayGrantRole(eb.val(role), eb.ref("invitation.role")))
          .select([
            "invitation.id",
            "invitation.email",
            "invitation.role",
            "invitation.createdAt",
            "invitation.expiresAt",
          ])
          .select((eb) =>
            jsonBuildObject({ id: eb.ref("user.id"), name: eb.ref("user.name") }).as("inviter"),
          )
          .$narrowType<{ role: string }>()
          .orderBy("invitation.createdAt", "desc")
          .orderBy("invitation.id")
          .execute(),
      ),
    );
  });
}

export const sweepInvitations = Db.use((database) =>
  database.query((db) =>
    db
      .deleteFrom("invitation")
      // Native acceptance marks the invitation accepted before adding the member. Keep the
      // row until expiry so the plugin can restore it if the membership write fails.
      .where("expiresAt", "<=", (eb) => eb.fn<Date>("now"))
      .execute(),
  ),
);
