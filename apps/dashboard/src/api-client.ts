import { createORPCClient, ORPCError } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { apiContract, createProblemDetailsLink } from "contract";
import ensureError from "ensure-error";

import { CONNECTION_FAILED } from "./auth-client.ts";

/**
 * The hub's API, on the page's own origin, which serves it (ADR 0043): its calls go to paths the
 * browser resolves against the page, and a member's carry the session cookie.
 */
export const api: ContractRouterClient<typeof apiContract> = createORPCClient(
  createProblemDetailsLink(apiContract, {}),
);

/** What went wrong with a call to the hub, in words for the member. */
export function apiFailureMessage(error: unknown): string {
  if (error instanceof ORPCError) return error.message;
  // A call that got no answer, or a mistake in the dashboard, which the console keeps.
  console.error(ensureError(error));
  return CONNECTION_FAILED;
}
