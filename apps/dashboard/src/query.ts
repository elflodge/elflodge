import { BetterFetchError } from "@better-fetch/fetch";
import { ORPCError, ResponseError } from "@orpc/client";
import { isRetryableError } from "@orpc/client/plugins";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import {
  QueryClient,
  type DataTag,
  type QueryKey,
  type UseQueryResult,
} from "@tanstack/solid-query";
import type { Runner } from "contract";
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

// Route loaders reuse a cached answer of any age; the page refreshes it on mount. When the
// first read fails, show the page's retry action immediately.
export const PAGE_LOAD = { staleTime: "static", retry: false } as const;

/** The client that holds what the dashboard reads from the hub, one for the document. */
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Let the mounted page reuse the answer its loader just fetched for the same query.
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

/** A timeout, rate limit or server failure may clear on the next read. oRPC can also reject
 * a response locally when it fails the contract. Retrying that response would not help. */
export function refused(error: Error) {
  if (error instanceof BetterFetchError) {
    const { status } = error;
    return status >= 400 && status < 500 && status !== 408 && status !== 429;
  }
  if (error instanceof ORPCError && !(error.cause instanceof ResponseError)) return true;
  return !isRetryableError(error);
}
