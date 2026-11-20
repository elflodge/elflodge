import { BetterFetchError } from "@better-fetch/fetch";
import { createAuthClient } from "better-auth/client";
import { customSessionClient, organizationClient } from "better-auth/client/plugins";
import type { Role } from "better-auth/plugins/access";

// The hub build needs the dashboard build. Declaring the hub as a dependency here would give
// vp's recursive build a cycle (dashboard#build -> hub#build -> dashboard#build).
import { ac, roles } from "../../hub/src/auth/access.ts";
import type { BetterAuth } from "../../hub/src/auth/auth.ts";

/**
 * Better Auth's client for the hub that serves the dashboard, at Better Auth's default path on the
 * page's own origin, the only one from which the hub signs members in (ADR 0015). Its framework-
 * neutral client, as its Solid adapter is built for Solid 1. Its organization plugin can check the
 * session role against the same permissions as the hub.
 */
export const authClient = createAuthClient({
  plugins: [
    // Better Auth stores combined roles as one string, which checkRolePermission accepts.
    organizationClient<{ ac: typeof ac; roles: Record<string, Role> }>({ ac, roles }),
    customSessionClient<BetterAuth>(),
  ],
  fetchOptions: { throw: true },
});

// The client's $ERROR_CODES is a fetch proxy at runtime. Only its type lists the codes.
export function hasAuthCode(
  error: unknown,
  ...codes: (keyof typeof authClient.$ERROR_CODES)[]
): error is BetterFetchError {
  return error instanceof BetterFetchError && codes.some((code) => code === error.error?.code);
}

// A refused session or permission can mean the member's access changed since the last read.
export function isAuthAccessError(error: unknown): boolean {
  return error instanceof BetterFetchError && [401, 403].includes(error.status);
}

/** A 401, as when the session was deleted during renewal, also means no one is signed in. */
export function isSignedOutError(error: unknown): boolean {
  return error instanceof BetterFetchError && error.status === 401;
}

/** Read the current session, returning null when the hub reports that it has ended. */
export async function getSession() {
  try {
    return await authClient.getSession();
  } catch (caught) {
    if (isSignedOutError(caught)) return null;
    throw caught;
  }
}
