import { BetterFetchError } from "@better-fetch/fetch";
import { createORPCClient, onError, ORPCError, ResponseError } from "@orpc/client";
import { TimeoutLinkPlugin } from "@orpc/client/plugins";
import { getProcedureContractOrThrow, type ContractRouterClient } from "@orpc/contract";
import { getOpenAPIMeta } from "@orpc/openapi";
import { apiContract, asError, createProblemDetailsLink, getAccess, problemOf } from "contract";

import { authClient } from "./auth-client.ts";

/**
 * How long the dashboard waits for the hub to answer one of its oRPC calls, or a Better Auth call a
 * confirmation waits on, before it gives up. A member cannot leave a confirmation, nor a form dialog
 * that writes to the hub, while its request runs, so a request the hub never answers has to end by
 * itself.
 */
export const HUB_DEADLINE_MS = 30_000;

/**
 * The calls whose request carries what a member submitted: a file, or a Batch's jobs with their
 * input, up to the hub's request limit. Sending one takes as long as the member's connection needs,
 * so these have no deadline; the pages that send them can be stopped or left while they run.
 */
const CALLS_CARRYING_CONTENT = new Set(["blobs.upload", "batches.create", "batches.addJobs"]);

/**
 * The hub's API, on the page's own origin, which serves it (ADR 0043): its calls go to paths the
 * browser resolves against the page, and a member's carry the session cookie.
 */
export const api: ContractRouterClient<typeof apiContract> = createORPCClient(
  createProblemDetailsLink(apiContract, {
    interceptors: [
      onError((error, { path }) => {
        if (!(error instanceof ORPCError) || error.code !== "UNAUTHORIZED") return;
        const procedure = getProcedureContractOrThrow(apiContract, path);
        if (!getAccess(procedure)?.member || getOpenAPIMeta(procedure)?.method !== "GET") return;
        // A background read can discover expiry while the tab stays open. The shell watches this
        // session and returns to sign-in if Better Auth confirms that it ended.
        const session = authClient.useSession.get();
        if (!session.isRefetching) void session.refetch();
      }),
    ],
    plugins: [
      new TimeoutLinkPlugin({
        timeout: ({ path }) =>
          CALLS_CARRYING_CONTENT.has(path.join(".")) ? undefined : HUB_DEADLINE_MS,
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
 * Whether the hub refused a write, with a 4xx status, so that nothing was done. Not `refused` from
 * query.ts, which also counts an error without Problem Details, as an answer that fails the contract
 * check is, since reading again would not help.
 */
export function isWriteRefusal(caught: unknown): boolean {
  const error = asError(caught);
  const status = error instanceof BetterFetchError ? error.status : problemOf(error)?.status;
  return status !== undefined && status >= 400 && status < 500;
}

/**
 * The words for a write that failed: the hub's own when it refused, with a 4xx status, so that
 * nothing was done. Any other failure may have come after the write was done: no answer within
 * `HUB_DEADLINE_MS`, a dropped connection, a 5xx from the hub or a proxy in front of it, or an
 * answer that does not match the contract.
 */
export function hubWriteFailureMessage(caught: unknown): string {
  const error = asError(caught);
  if (isWriteRefusal(error)) return hubFailureMessage(error);
  // A mistake in the dashboard ends here too, which the console keeps.
  console.error(error);
  return "The dashboard could not confirm this was done. Check before trying again.";
}

/**
 * A refusal describes the input. Any other error from a call that returns a secret can carry it
 * in the message, response body or cause, so give the caller a fresh error it can safely log.
 */
export function secretAnswerFailure(caught: unknown): Error {
  const error = asError(caught);
  if (isWriteRefusal(error)) return error;
  const responseError = error instanceof ORPCError ? error.cause : error;
  const status =
    responseError instanceof ResponseError
      ? responseError.response.status
      : problemOf(error)?.status;
  return new Error(status === undefined ? error.name : `${error.name}, status ${status}`);
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
