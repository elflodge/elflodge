import { ORPCError } from "@orpc/client";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient } from "@tanstack/solid-query";

import { api } from "./api-client.ts";

/**
 * Query keys and options for every call of the hub's API, built from the contract, such as
 * `orpc.jobs.counts.queryOptions({ input: {} })`, or `orpc.jobs.key()` for every read of jobs.
 */
export const orpc = createTanstackQueryUtils(api);

/**
 * The query clients of the sessions signed in, one after another, in one tab: each session's reads
 * are held by a client of its own, so that a member never sees what was read for the one before.
 * The router's context carries it, as `queries`; a route's context cannot carry a client itself,
 * since TanStack Start requires what `beforeLoad` returns to be serializable.
 */
export function createSessionQueries() {
  let current: { sessionId: string; queryClient: QueryClient } | undefined;

  /** Stops the open session's reads and forgets what it read. */
  function end() {
    if (!current) return;
    const { queryClient } = current;
    current = undefined;
    // A read still on its way lands in this client, which nothing reads any longer.
    void queryClient.cancelQueries();
    queryClient.clear();
  }

  return {
    /** Opens the session `sessionId`, ending the one before if it is another, and gives its client. */
    open(sessionId: string): QueryClient {
      if (current?.sessionId !== sessionId) {
        end();
        current = { sessionId, queryClient: newQueryClient() };
      }
      return current.queryClient;
    },
    /** The client of the open session, which every page inside the shell has. */
    get client(): QueryClient {
      if (!current) throw new Error("No session is open");
      return current.queryClient;
    },
    end,
  };
}
export type SessionQueries = ReturnType<typeof createSessionQueries>;

function newQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Long enough that a page the pointer preloaded, or one left and opened again, shows what
        // was just read without asking again; short enough that what it shows is current.
        staleTime: 10_000,
        // The hub answered: asking again gets the same answer. A call that got no answer may
        // still get one, so it is tried again, as Query does by default.
        retry: (failureCount, error) => !(error instanceof ORPCError) && failureCount < 3,
      },
    },
  });
}
