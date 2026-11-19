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

/** The client that holds what the dashboard reads from the hub, one for the document. */
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // A click soon after a preload reuses the answer, as a revisit to Prefect's task runs does.
        // https://github.com/PrefectHQ/prefect/blob/ec4b188a19371cb79bc91afe897042bca3a3c95f/ui-v2/src/api/task-runs/index.ts#L88-L105
        staleTime: 1000,
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
