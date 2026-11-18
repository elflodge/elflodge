import { createORPCClient, ORPCError } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { apiContract, createProblemDetailsLink } from "contract";
import ensureError from "ensure-error";

/**
 * The hub's API, on the page's own origin, which serves it (ADR 0043); a member's calls carry the
 * session cookie. The origin is read when a call is made, as building the shell imports this
 * module where there is no page.
 */
export const api: ContractRouterClient<typeof apiContract> = createORPCClient(
  createProblemDetailsLink(apiContract, { origin: () => location.origin }),
);

/** What went wrong with a call to the hub, in words for the member. */
export function apiFailureMessage(error: unknown): string {
  if (error instanceof ORPCError) return error.message;
  // A call that got no answer, or a mistake in the dashboard, which the console keeps.
  console.error(ensureError(error));
  return "The connection to the hub failed. Please try again.";
}
