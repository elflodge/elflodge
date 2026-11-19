import { ORPCError } from "@orpc/client";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient } from "@tanstack/solid-query";
import { problemOf } from "contract";
import { createSignal } from "solid-js";

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
 * Follows which member is signed in, by their user ID, and forgets every read `queryClient` holds
 * when it changes, so that a member never sees what was read for another. A new session for the
 * same member, such as the one a password change makes, keeps them.
 */
export function followMember(queryClient: QueryClient) {
  // The member whose reads the client holds: `null` for none, `undefined` before the first answer.
  const [confirmedMember, setConfirmedMember] = createSignal<string | null | undefined>(undefined);
  // Kept beside the signal, whose new value a read gets only after Solid 2 flushes the write.
  let seen: string | null | undefined;
  return {
    /** The member the hub last said is signed in, for the shell to hide another member's page. */
    confirmedMember,
    /**
     * Told the member the hub answered with, `null` for none; says whether it is another than the
     * one before, whose reads it has then forgotten.
     */
    memberSeen(memberId: string | null): boolean {
      const changed = seen !== undefined && memberId !== seen;
      seen = memberId;
      setConfirmedMember(memberId);
      // The first member seen is the one whose reads the client will hold: it holds none before.
      if (!changed) return false;
      // Removing a query cancels its read, so an answer still on its way is dropped, not held.
      //
      // One client for the tab, rather than one for each member, lets the router's context and the
      // provider stay the same for the tab's life. What it leaves open: a control's answer that
      // arrives after the member changed is written into the next member's reads. That takes the
      // member to change, signed out and in as another here or in another tab, while a control
      // waits for its answer. Members of a hub share its one Organization and see the same jobs,
      // so what could pass is only what a role allows one member and not the other, or what is a
      // member's own. A client for each member closes that, at the cost of swapping the provider
      // and the router's context with the member, which every page then has to follow.
      queryClient.clear();
      return true;
    },
  };
}
