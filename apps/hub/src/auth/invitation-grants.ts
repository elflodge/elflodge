import { expressionBuilder, type Expression, type Kysely } from "kysely";

import { hasOwnerRole, storedRoles } from "../db/roles.ts";
import type { Database, OrganizationId, UserId } from "../db/types.ts";
import { roles } from "./access.ts";

const invitationRoles = Object.entries(roles)
  .filter(([, role]) => role.authorize({ invitation: ["create"] }).success)
  .map(([name]) => name);

function mayInvite(role: Expression<string | null>) {
  const eb = expressionBuilder();
  return eb(storedRoles(role), "&&", eb.val(invitationRoles));
}

/**
 * An invitation grants one or more configured roles. Only an owner may include owner in the grant.
 */
export function mayGrantRole(
  inviterRole: Expression<string | null>,
  grant: Expression<string | null>,
) {
  const eb = expressionBuilder();
  return eb.and([
    mayInvite(inviterRole),
    eb(eb.fn<number>("cardinality", [storedRoles(grant)]), ">", 0),
    eb(storedRoles(grant), "<@", eb.val(Object.keys(roles))),
    eb.or([hasOwnerRole(inviterRole), eb.not(hasOwnerRole(grant))]),
  ]);
}

function pendingInvitations(db: Kysely<Database>) {
  return db
    .selectFrom("invitation")
    .where("invitation.status", "=", "pending")
    .where("invitation.expiresAt", ">", (eb) => eb.fn<Date>("clock_timestamp"));
}

/** Only invitations the original inviter could issue now are visible or redeemable. */
export function liveInvitations(db: Kysely<Database>) {
  return pendingInvitations(db)
    .innerJoin("member", (join) =>
      join
        .onRef("member.organizationId", "=", "invitation.organizationId")
        .onRef("member.userId", "=", "invitation.inviterId"),
    )
    .where((eb) => mayGrantRole(eb.ref("member.role"), eb.ref("invitation.role")));
}

/**
 * Pending invitations to `email` in the Organization, from any inviter, with the caller's and the
 * original inviter's membership. Members who cannot invite anyone find none, so they get the same
 * permission error for every address.
 */
function pendingInvitationsByEmailForCaller(
  db: Kysely<Database>,
  organizationId: OrganizationId,
  userId: UserId,
  email: string,
) {
  return pendingInvitations(db)
    .innerJoin("member as caller", (join) =>
      join
        .onRef("caller.organizationId", "=", "invitation.organizationId")
        .on("caller.userId", "=", userId),
    )
    .leftJoin("member as inviter", (join) =>
      join
        .onRef("inviter.organizationId", "=", "invitation.organizationId")
        .onRef("inviter.userId", "=", "invitation.inviterId"),
    )
    .where("invitation.organizationId", "=", organizationId)
    .where("invitation.email", "=", email)
    .where((eb) => mayInvite(eb.ref("caller.role")));
}

/** Like `mayGrantRole`, for an inviter who may have left the Organization and so grants nothing. */
function remainingInviterMayGrantRole(
  inviterRole: Expression<string | null>,
  grant: Expression<string | null>,
) {
  const eb = expressionBuilder();
  return eb.fn.coalesce(mayGrantRole(inviterRole, grant), eb.lit(false));
}

/** A live invitation to `email` that a plain re-invite by the caller would replace without the right. */
export function findLiveInvitationCallerCannotGrantByEmail(
  db: Kysely<Database>,
  organizationId: OrganizationId,
  userId: UserId,
  email: string,
) {
  return pendingInvitationsByEmailForCaller(db, organizationId, userId, email)
    .where((eb) =>
      eb.and([
        remainingInviterMayGrantRole(eb.ref("inviter.role"), eb.ref("invitation.role")),
        eb.not(mayGrantRole(eb.ref("caller.role"), eb.ref("invitation.role"))),
      ]),
    )
    .select("invitation.id")
    .limit(1)
    .executeTakeFirst();
}

/** A pending invitation to `email` the caller could grant whose inviter no longer can, so a resend would renew it. */
export function findInvitationInviterCannotGrantByEmail(
  db: Kysely<Database>,
  organizationId: OrganizationId,
  userId: UserId,
  email: string,
) {
  return pendingInvitationsByEmailForCaller(db, organizationId, userId, email)
    .where((eb) =>
      eb.and([
        mayGrantRole(eb.ref("caller.role"), eb.ref("invitation.role")),
        eb.not(remainingInviterMayGrantRole(eb.ref("inviter.role"), eb.ref("invitation.role"))),
      ]),
    )
    .select("invitation.id")
    .limit(1)
    .executeTakeFirst();
}
