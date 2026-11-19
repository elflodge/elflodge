import { BetterFetchError } from "@better-fetch/fetch";
import { createAuthClient } from "better-auth/client";
import { organizationClient } from "better-auth/client/plugins";

/**
 * Better Auth's client for the hub that serves the dashboard, at Better Auth's default path on the
 * page's own origin, the only one from which the hub signs members in (ADR 0015). Its framework-
 * neutral client, as its Solid adapter is built for Solid 1. Its organization plugin reads the
 * Organization.
 */
export const authClient = createAuthClient({
  plugins: [organizationClient()],
  fetchOptions: { throw: true },
});

/** A 401, as when the session was deleted during renewal, also means no one is signed in. */
export function isSignedOutError(error: unknown): boolean {
  return error instanceof BetterFetchError && error.status === 401;
}

export async function getSession() {
  try {
    return await authClient.getSession();
  } catch (caught) {
    if (isSignedOutError(caught)) return null;
    throw caught;
  }
}
