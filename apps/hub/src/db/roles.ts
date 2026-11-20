import { expressionBuilder, type Expression } from "kysely";

/** The role names Better Auth stores together in a membership or invitation. */
export function storedRoles(role: Expression<string | null>) {
  return expressionBuilder().fn<string[]>("elflodge.stored_roles", [role]);
}

/** Shared with the trigger so reads and writes recognize the same owners. */
export function hasOwnerRole(role: Expression<string | null>) {
  return expressionBuilder().fn<boolean>("elflodge.has_owner_role", [role]);
}
