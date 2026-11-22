import { BetterFetchError } from "@better-fetch/fetch";
import { createORPCClient, ORPCError } from "@orpc/client";
import { TimeoutLinkPlugin } from "@orpc/client/plugins";
import type { ContractRouterClient } from "@orpc/contract";
import { apiContract, asError, createProblemDetailsLink } from "contract";

/**
 * How long the dashboard waits for the hub to answer a call before it gives up. A member cannot
 * leave a confirmation while its request runs, so a request the hub never answers has to end by
 * itself. An upload takes as long as its file needs, so it has none.
 */
export const HUB_DEADLINE_MS = 30_000;

/**
 * The hub's API, on the page's own origin, which serves it (ADR 0043): its calls go to paths the
 * browser resolves against the page, and a member's carry the session cookie.
 */
export const api: ContractRouterClient<typeof apiContract> = createORPCClient(
  createProblemDetailsLink(apiContract, {
    plugins: [
      new TimeoutLinkPlugin({
        timeout: ({ path }) => (path.join(".") === "blobs.upload" ? undefined : HUB_DEADLINE_MS),
      }),
    ],
  }),
);

/** The hub may refuse a call without providing a detail. */
export function hubFailureDetail(caught: unknown): string {
  const error = asError(caught);
  if (error instanceof ORPCError) return error.message;
  if (error instanceof BetterFetchError) {
    const message: unknown = error.error?.message;
    if (typeof message === "string" && message.trim()) return message;
    // A proxy can answer without a body, and HTTP/2 has no status text.
    return error.statusText || `The hub answered with HTTP status ${error.status}.`;
  }
  // A call that got no answer, or a mistake in the dashboard, which the console keeps.
  console.error(error);
  return "The connection to the hub failed. Please try again.";
}

/** Standalone action alerts need a message even when the hub supplied no detail. */
export function hubFailureMessage(caught: unknown): string {
  const detail = hubFailureDetail(caught);
  return detail.trim() ? detail : "The hub could not complete the request.";
}

/**
 * The words for a write that failed: the hub's refusal, or, when no answer came, as when the hub
 * took longer than `HUB_DEADLINE_MS` or the connection dropped, that the hub may have done it
 * anyway, since the request may have reached it.
 */
export function hubWriteFailureMessage(caught: unknown): string {
  const error = asError(caught);
  if (error instanceof ORPCError || error instanceof BetterFetchError)
    return hubFailureMessage(error);
  // A mistake in the dashboard ends here too, which the console keeps.
  console.error(error);
  return "The hub did not answer, so this may have been done anyway. Check before trying again.";
}

/** Finish a failure notice with the hub's words when it supplied any. */
export function failureDetailSuffix(detail: string): string {
  return detail.trim() ? `: ${detail}` : ".";
}

/** The page keeps the failure it received even if another reader has already retried the query. */
export class HubReadError extends Error {
  readonly failedAt = Date.now();

  readonly what: string;
  readonly detail: string;

  constructor(what: string, cause: unknown) {
    const detail = hubFailureDetail(cause);
    super(`${what} could not be read${failureDetailSuffix(detail)}`, { cause });
    this.what = what;
    this.detail = detail;
  }
}

/**
 * What `read`, a call of the hub's API, reads. A read that fails throws an error that names
 * `what`, for the page shown in place of the one that needed it.
 */
export async function readFromHub<T>(what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (caught) {
    throw new HubReadError(what, caught);
  }
}
