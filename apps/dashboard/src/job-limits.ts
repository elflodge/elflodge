import { noop, useQuery, type QueryClient } from "@tanstack/solid-query";
import { createMemo, deep, latest } from "solid-js";

import { orpc } from "./query.ts";

// Apart from the agent's fields: a route's loader is in the code every page loads, which would
// otherwise carry the fields with it.

/**
 * Starts reading the hub's limits from a route's loader. Not awaited: the form works without them,
 * as they only fill two hints. Preloading on intent starts the read before the page shows.
 */
export function preloadJobLimits(context: { member?: unknown; queryClient: QueryClient }) {
  if (context.member)
    void context.queryClient
      .query(orpc.jobs.limits.queryOptions({ staleTime: "static" }))
      .catch(noop);
}

/**
 * The hub's limits for a job's model budget and run timeout, as last read, kept through a failed
 * background read, and whether the read failed. Reading `data` before the first answer would
 * suspend the page, which must not wait for the limits.
 */
export function useJobLimits() {
  const limits = useQuery(() => orpc.jobs.limits.queryOptions());
  // Through `latest`: while the limits are read again with data present, as when the member returns
  // to the tab, `data` is a pending value, and a flush that recomputes anything reading it waits
  // for the read, with every write staged in it. Removing every row recomputes the draft's figures
  // from the limits, which held the rows, the status line and the closed dialog until the read
  // landed.
  const held = createMemo(() =>
    limits.dataUpdatedAt ? latest(() => deep(limits.data)) : undefined,
  );
  return {
    held,
    failed: () => limits.isError,
  };
}
