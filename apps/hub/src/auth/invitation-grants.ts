import { expressionBuilder, type Expression, type Kysely } from "kysely";

import { hasOwnerRole } from "../db/roles.ts";
import type { Database } from "../db/types.ts";

/** Better Auth checks the caller's invitation permission. Owner invitations are managed by owners. */
export function mayManageInvitation(
  caller: Expression<string | null>,
  grant: Expression<string | null>,
) {
  const eb = expressionBuilder();
  return eb.or([hasOwnerRole(caller), eb.not(hasOwnerRole(grant))]);
}

export function pendingInvitations(db: Kysely<Database>) {
  return db
    .selectFrom("invitation")
    .where("invitation.role", "is not", null)
    .where("invitation.status", "=", "pending")
    .where("invitation.expiresAt", ">", (eb) => eb.fn<Date>("now"));
}
