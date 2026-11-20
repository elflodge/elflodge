import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";
import { KEY_PERMISSIONS } from "contract";
import { expressionBuilder, type Expression } from "kysely";

/** What an API key or a member's role may do, in Better Auth's `{ resource: actions }` shape. */
const statements = {
  ...defaultStatements,
  // The key routes require a member's session so an API key cannot manage other keys.
  // The hub lists API keys for members whose role grants apiKey:read. Better Auth checks the
  // signed-in member's permissions when it creates or deletes a key on their behalf.
  apiKey: ["create", "read", "update", "delete"],
  ...KEY_PERMISSIONS,
  // Reading the Organization's usage, which a member's role grants; no key may be granted it yet.
  usage: ["read"],
} as const;

export const ac = createAccessControl(statements);

/**
 * Better Auth's default organization roles, with key management granted to owners and admins, as in
 * Better Auth's API key docs. Its key routes let owners do everything anyway; granting it in the role
 * makes a check of the role's permissions, as the hub makes before removing a Runner, decide as they
 * do. Members have none, so keys stay with admins and owners, as Buildkite's agent tokens do. Owners
 * and admins also read the Organization's usage, which shows what every member's work cost.
 */
export const roles = {
  owner: ac.newRole({
    ...ownerAc.statements,
    apiKey: ["create", "read", "update", "delete"],
    usage: ["read"],
  }),
  admin: ac.newRole({
    ...adminAc.statements,
    apiKey: ["create", "read", "update", "delete"],
    usage: ["read"],
  }),
  member: memberAc,
};

/** Better Auth stores role names joined by commas, including for a grant of several roles. */
export function storedRoles(role: Expression<string | null>) {
  const eb = expressionBuilder();
  return eb.fn<string[]>("regexp_split_to_array", [
    eb.fn("btrim", [role]),
    eb.val("[[:space:]]*,[[:space:]]*"),
  ]);
}

/** Shared with the database trigger so membership writes and authorization recognize the same owners. */
export function hasOwnerRole(role: Expression<string | null>) {
  return expressionBuilder().fn<boolean>("elflodge.has_owner_role", [role]);
}
