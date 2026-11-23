import { BetterFetchError } from "@better-fetch/fetch";
import { ORPCError } from "@orpc/client";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import {
  QueryClient,
  type DataTag,
  type QueryKey,
  type UseQueryResult,
} from "@tanstack/solid-query";
import { problemOf, type Runner } from "contract";
import { onFlush } from "solid-js";

import { api } from "./api-client.ts";

// Bull Board polls its queue counts and jobs at this interval while the dashboard is open.
// https://github.com/felixmosh/bull-board/blob/4d98710f7e8bee0cfcd5a158caadf9fd109b4cb1/website/docs/recipes/change-polling-interval.md
export const REFRESH_INTERVAL_MS = 5_000;

/**
 * Query keys and options for every call of the hub's API, built from the contract, such as
 * `orpc.jobs.counts.queryOptions({ input: {} })`, or `orpc.jobs.key()` for every read of jobs.
 */
export const orpc = createTanstackQueryUtils(api);

// Reading data before the first Runner answer suspends the list, even after its own list arrived.
export function availableRunners(query: UseQueryResult<Runner[]>) {
  return query.dataUpdatedAt ? query.data : undefined;
}

/**
 * Resolves after Solid’s scheduled flush. A transition can still hold writes. A UI SDK action
 * waits for this before calling `mutate` so the mutation does not hold the part’s pending state
 * until the hub answers. `createFormAction` waits so UI SDK can register a newly mounted
 * description before focus moves to the refused control.
 */
export function untilFlushed() {
  return new Promise<void>((resolve) => onFlush(resolve));
}

/**
 * Writes the one fact a check found, that a record is gone, into the cached list `queryKey`, where
 * `without` takes it out. Only that is written: a read that landed while the check ran can hold a
 * newer list than the check saw. Reads of the list still running are cancelled first, since one that
 * started before the record went could bring it back. The list keeps the time it was read, as what is
 * left of it is no newer, and is marked stale but not fetched, since a fetch now would hold the
 * written list back until it answered.
 */
export async function writeAbsence<T, E>(
  queryClient: QueryClient,
  queryKey: DataTag<QueryKey, T, E>,
  without: (cached: T) => T,
) {
  await queryClient.cancelQueries({ queryKey, exact: true });
  queryClient.setQueryData(
    queryKey,
    (cached) => (cached === undefined ? cached : without(cached)),
    { updatedAt: queryClient.getQueryState(queryKey)?.dataUpdatedAt },
  );
  await queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "none" });
}

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
      mutations: {
        // Sent at once, or failed at once while offline: by default Query would hold a control the
        // member confirmed offline and send it on reconnect, after the page had moved on.
        networkMode: "always",
      },
    },
  });
}

/**
 * Whether the hub refused the call, which asking again would not change: an answer with a 4xx
 * status, or one oRPC itself turned down, such as one the contract does not allow. A 5xx failure or
 * a call that got no answer may go through when tried again, as Query does by default.
 */
export function refused(error: Error) {
  if (error instanceof BetterFetchError) return error.status >= 400 && error.status < 500;
  if (!(error instanceof ORPCError)) return false;
  const status = problemOf(error)?.status;
  return status === undefined || status < 500;
}
