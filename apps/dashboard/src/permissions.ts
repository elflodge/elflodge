import { authClient } from "./auth-client.ts";

/** Key management also allows removing a Runner, whose key the hub removes with it. */
export function canManageKeys(role: string): boolean {
  return authClient.organization.checkRolePermission({
    role,
    permissions: { apiKey: ["create", "read", "delete"] },
  });
}
