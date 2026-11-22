import { BetterFetchError } from "@better-fetch/fetch";
import { createAuthClient } from "better-auth/client";
import { customSessionClient, organizationClient } from "better-auth/client/plugins";
import type { Role } from "better-auth/plugins/access";

// The hub build needs the dashboard build. Declaring the hub as a dependency here would give
// vp's recursive build a cycle (dashboard#build -> hub#build -> dashboard#build).
import { ac, roles } from "../../hub/src/auth/access.ts";
import type { BetterAuth } from "../../hub/src/auth/auth.ts";
import { HUB_DEADLINE_MS } from "./api-client.ts";

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
  // better-fetch's timeout covers a call made without a signal of its own, and only until the
  // answer's headers arrive. The session read and its renewal, and Query's reads of the members,
  // pass a signal, so they have no deadline, and none locks a dialog. The writes the Organization
  // page confirms have it, as has the one members read that decides whether a member is gone.
  fetchOptions: { throw: true, timeout: HUB_DEADLINE_MS },
});

/**
 * Whether the hub refused with one of Better Auth's `codes`, checked against the client's type. At
 * run time the client's `$ERROR_CODES` is a fetch proxy, and the plugins' own exports leave out the
 * base codes, such as INVALID_PASSWORD.
 */
export function hasAuthCode(
  error: unknown,
  ...codes: (keyof typeof authClient.$ERROR_CODES)[]
): boolean {
  return error instanceof BetterFetchError && codes.some((code) => code === error.error?.code);
}

/** A refused session or permission can mean the member's access changed since the last read. */
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
