import { authClient } from "./auth-client.ts";

/** Key management also allows removing a Runner, whose key the hub removes with it. */
export function canManageKeys(membership: typeof authClient.$Infer.Session.membership): boolean {
  return (
    membership.status === "member" &&
    authClient.organization.checkRolePermission({
      role: membership.role,
      permissions: { apiKey: ["create", "read", "delete"] },
    })
  );
}

export function canReadUsage(membership: typeof authClient.$Infer.Session.membership): boolean {
  return (
    membership.status === "member" &&
    authClient.organization.checkRolePermission({
      role: membership.role,
      permissions: { usage: ["read"] },
    })
  );
}
