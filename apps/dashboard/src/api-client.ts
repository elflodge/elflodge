import { BetterFetchError } from "@better-fetch/fetch";
import { createORPCClient, ORPCError } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { apiContract, createProblemDetailsLink } from "contract";
import ensureError from "ensure-error";

/**
 * The hub's API, on the page's own origin, which serves it (ADR 0043): its calls go to paths the
 * browser resolves against the page, and a member's carry the session cookie.
 */
export const api: ContractRouterClient<typeof apiContract> = createORPCClient(
  createProblemDetailsLink(apiContract, {}),
);

/** What went wrong with a call to the hub, in words for the member. */
export function apiFailureMessage(caught: unknown): string {
  const error: Error = ensureError(caught);
  if (error instanceof ORPCError) return error.message;
  if (error instanceof BetterFetchError) {
    const message: unknown = error.error?.message;
    if (typeof message === "string" && message) return message;
    // A proxy can answer without a body, and HTTP/2 has no status text.
    return error.statusText || `The hub answered with HTTP status ${error.status}.`;
  }
  // A call that got no answer, or a mistake in the dashboard, which the console keeps.
  console.error(error);
  return "The connection to the hub failed. Please try again.";
}

/**
 * What `read`, a call of the hub's API, reads. A read that fails throws an error that names
 * `what`, for the page shown in place of the one that needed it.
 */
export async function readApi<T>(what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (caught) {
    throw new Error(`${what} could not be read: ${apiFailureMessage(caught)}`, {
      cause: caught,
    });
  }
}
