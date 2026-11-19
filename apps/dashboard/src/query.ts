import { ORPCError } from "@orpc/client";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient } from "@tanstack/solid-query";
import { problemOf } from "contract";

import { api } from "./api-client.ts";

/**
 * Query keys and options for every call of the hub's API, built from the contract, such as
 * `orpc.jobs.counts.queryOptions({ input: {} })`, or `orpc.jobs.key()` for every read of jobs.
 */
export const orpc = createTanstackQueryUtils(api);

/** The client that holds what the dashboard reads from the hub, one for the tab. */
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // A page read 10 seconds ago or less is shown without asking again: one the pointer
        // preloaded a moment before the click, or one left and opened again straight away. Older,
        // it is shown and read again behind it, so a member never looks at a page minutes old.
        staleTime: 10_000,
        retry: (failureCount, error) => !refused(error) && failureCount < 3,
      },
    },
  });
}

/**
 * Whether the hub refused the call, which asking again would not change: an answer with a 4xx
 * status, or one oRPC itself turned down, such as one the contract does not allow. A 5xx failure or
 * a call that got no answer may go through when tried again, as Query does by default.
 */
function refused(error: Error) {
  if (!(error instanceof ORPCError)) return false;
  const status = problemOf(error)?.status;
  return status === undefined || status < 500;
}

/**
 * Remembers whose session `queryClient`'s reads were made in, and forgets them all when another
 * session is seen, so that a member never sees what was read for the one before. `sessionSeen` is
 * told the session the hub answered with, `null` for none, and says whether it changed.
 */
export function forgetReadsOnSessionChange(queryClient: QueryClient) {
  let seen: string | null | undefined;
  return function sessionSeen(sessionId: string | null): boolean {
    // The first session seen is the one whose reads the client will hold: it holds none before.
    if (seen === undefined) {
      seen = sessionId;
      return false;
    }
    if (sessionId === seen) return false;
    seen = sessionId;
    // Removing a query cancels its read, so an answer still on its way is dropped, not held.
    //
    // One client for the tab, rather than one for each session, lets the router's context and the
    // provider stay the same for the tab's life. What it leaves open: a control's answer that
    // arrives after the session changed is written into the next member's reads. That takes the
    // session to change, in another tab, while a control here waits for its answer. Members of a
    // hub share its one Organization and see the same jobs, so what could pass is only what a
    // role allows one member and not the other, or what is a member's own. A client for each
    // session closes that, at the cost of swapping the provider and the router's context with the
    // session, which every page then has to follow.
    queryClient.clear();
    return true;
  };
}
