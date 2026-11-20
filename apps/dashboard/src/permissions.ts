import { authClient } from "./auth-client.ts";

type Membership = typeof authClient.$Infer.Session.membership;
type Permissions = Parameters<typeof authClient.organization.checkRolePermission>[0]["permissions"];

function hasPermission(membership: Membership, permissions: Permissions): boolean {
  return (
    membership.status === "member" &&
    authClient.organization.checkRolePermission({ role: membership.role, permissions })
  );
}

/** Key management also allows removing a Runner, whose key the hub removes with it. */
export function canManageKeys(membership: Membership): boolean {
  return hasPermission(membership, { apiKey: ["create", "read", "delete"] });
}

export function canReadUsage(membership: Membership): boolean {
  return hasPermission(membership, { usage: ["read"] });
}
