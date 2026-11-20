import { expressionBuilder, type Expression, type Kysely } from "kysely";

import { hasOwnerRole, storedRoles } from "../db/roles.ts";
import type { Database, OrganizationId, UserId } from "../db/types.ts";
import { roles } from "./access.ts";

const invitationRoles = Object.entries(roles)
  .filter(([, role]) => role.authorize({ invitation: ["create"] }).success)
  .map(([name]) => name);

function mayInvite(role: Expression<string>) {
  const eb = expressionBuilder();
  return eb(storedRoles(role), "&&", eb.val(invitationRoles));
}

/**
 * Better Auth grants at least one role, only configured roles, and only an owner can grant a role
 * containing owner.
 */
export function mayGrantRole(inviterRole: Expression<string>, grant: Expression<string | null>) {
  const eb = expressionBuilder();
  return eb.and([
    mayInvite(inviterRole),
    eb(eb.fn<number>("cardinality", [storedRoles(grant)]), ">", 0),
    eb(storedRoles(grant), "<@", eb.val(Object.keys(roles))),
    eb.or([hasOwnerRole(inviterRole), eb.not(hasOwnerRole(grant))]),
  ]);
}

/** Only invitations the original inviter could issue now are visible or redeemable. */
export function liveInvitations(db: Kysely<Database>) {
  return db
    .selectFrom("invitation")
    .innerJoin("member", (join) =>
      join
        .onRef("member.organizationId", "=", "invitation.organizationId")
        .onRef("member.userId", "=", "invitation.inviterId"),
    )
    .where("invitation.status", "=", "pending")
    .where("invitation.expiresAt", ">", (eb) => eb.fn<Date>("clock_timestamp"))
    .where((eb) => mayGrantRole(eb.ref("member.role"), eb.ref("invitation.role")));
}

export function findLiveInvitationCallerCannotGrantByEmail(
  db: Kysely<Database>,
  organizationId: OrganizationId,
  userId: UserId,
  email: string,
) {
  return (
    liveInvitations(db)
      .innerJoin("member as caller", (join) =>
        join
          .onRef("caller.organizationId", "=", "invitation.organizationId")
          .on("caller.userId", "=", userId),
      )
      .where("invitation.organizationId", "=", organizationId)
      .where("invitation.email", "=", email)
      // Let Better Auth return its ordinary permission error for members who cannot invite anyone.
      .where((eb) => mayInvite(eb.ref("caller.role")))
      .where((eb) => eb.not(mayGrantRole(eb.ref("caller.role"), eb.ref("invitation.role"))))
      .select("invitation.id")
      .limit(1)
      .executeTakeFirst()
  );
}
