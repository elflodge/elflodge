import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/solid-query";
import {
  FINAL_JOB_STATUSES,
  asError,
  type Job,
  type JobEventOrder,
  type JobEventsPage,
} from "contract";
import { createEffect, createMemo, createSignal } from "solid-js";

import { REFRESH_INTERVAL_MS, orpc } from "./query.ts";

function historyOptions(id: string, order: JobEventOrder) {
  return orpc.jobs.events.infiniteOptions({
    input: (after: number) => ({
      id,
      order,
      after: order === "desc" && after === 0 ? undefined : after,
      limit: 100,
    }),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.hasMore ? last.events.at(-1)?.id : undefined),
    // These Events are immutable. A refresh of an infinite query rereads every page from
    // the first cursor, which would move the stretch as new Events arrive.
    staleTime: "static",
    gcTime: 0,
  });
}

/** The member extends one end on request. The other follows the journal once caught up. */
export function useJobEventStretch(
  job: () => Job,
  enabled: () => boolean,
  jobReadAt: () => number,
) {
  const client = useQueryClient();
  const [order, setOrder] = createSignal<JobEventOrder>("desc");
  const [switching, setSwitching] = createSignal(false);
  const [jumpFailure, setJumpFailure] = createSignal<{ error: Error; failedAt: number }>();
  const history = useInfiniteQuery(() => ({
    ...historyOptions(job().id, order()),
    enabled: enabled(),
    refetchInterval: (query) =>
      query.state.error && !query.state.data ? REFRESH_INTERVAL_MS : false,
  }));
  const pages = () => (history.dataUpdatedAt ? history.data.pages : []);
  const historyEvents = createMemo(() => {
    const events = pages().flatMap((page) => page.events);
    return order() === "desc" ? events.toReversed() : events;
  });
  const hasLater = () => order() === "asc" && history.hasNextPage;
  const tailCursor = () =>
    pages().length && !hasLater() ? (historyEvents().at(-1)?.id ?? 0) : undefined;

  const follow = useQuery(() => {
    const after = tailCursor();
    const id = job().id;
    const key = [...orpc.jobs.events.key({ input: { id } }), "follow", after];
    // An ascending history page can itself reach the end. Its status already answers
    // whether to wait for a resume or read again after the dashboard's interval.
    const last = order() === "asc" && after !== undefined ? pages().at(-1) : undefined;
    return {
      queryKey: key,
      enabled: enabled() && after !== undefined,
      initialData: last ? { events: [], status: last.status, hasMore: false } : undefined,
      staleTime: "static",
      gcTime: 0,
      queryFn: async ({ signal }): Promise<JobEventsPage> => {
        const previous = client.getQueryData<JobEventsPage>(key);
        const page = await orpc.jobs.events.call(
          {
            id,
            after: previous?.events.at(-1)?.id ?? after,
            order: "asc",
            limit: 100,
          },
          { signal },
        );
        if (!previous?.events.length) return page;
        return {
          ...page,
          events: page.events.length ? previous.events.concat(page.events) : previous.events,
        };
      },
      refetchInterval: (query) => {
        const page = query.state.data;
        if (query.state.error) return REFRESH_INTERVAL_MS;
        if (page?.hasMore) return 1;
        return page && !page.hasMore && FINAL_JOB_STATUSES.includes(page.status)
          ? false
          : REFRESH_INTERVAL_MS;
      },
    };
  });
  // A job can end and resume between two reads of its status. A *later* job read that
  // shows it unfinished is enough to follow again, even if the earlier read also said running.
  createEffect(jobReadAt, (readAt) => {
    if (
      !enabled() ||
      tailCursor() === undefined ||
      follow.isFetching ||
      !follow.dataUpdatedAt ||
      readAt <= follow.dataUpdatedAt ||
      FINAL_JOB_STATUSES.includes(job().status)
    )
      return;
    const last = follow.data;
    if (!last.hasMore && FINAL_JOB_STATUSES.includes(last.status)) void follow.refetch();
  });
  const liveEvents = createMemo(() =>
    tailCursor() !== undefined && follow.dataUpdatedAt ? follow.data.events : [],
  );
  const events = createMemo(() => historyEvents().concat(liveEvents()));

  async function jump(next: JobEventOrder) {
    if (!enabled() || switching()) return false;
    setSwitching(true);
    setJumpFailure(undefined);
    try {
      await client.infiniteQuery({ ...historyOptions(job().id, next), staleTime: 0, pages: 1 });
      setOrder(next);
      return true;
    } catch (error) {
      setJumpFailure({ error: asError(error), failedAt: Date.now() });
      return false;
    } finally {
      setSwitching(false);
    }
  }
  async function extend(direction: JobEventOrder) {
    if (!enabled() || order() !== direction || isFetchingPage() || !history.hasNextPage)
      return false;
    setJumpFailure(undefined);
    return (await history.fetchNextPage()).isSuccess;
  }
  const isFetchingPage = () => history.isFetching || switching();
  function failure() {
    const readAt = Math.max(follow.dataUpdatedAt, history.dataUpdatedAt);
    const failed = jumpFailure();
    if (failed) return { ...failed, readAt };
    const read = history.isError ? history : follow;
    return read.isError ? { error: read.error, failedAt: read.errorUpdatedAt, readAt } : undefined;
  }

  return {
    events,
    liveEvents,
    hasEarlier: () => order() === "desc" && history.hasNextPage,
    hasLater,
    isAtLatest: () =>
      !!pages().length && !hasLater() && !(follow.dataUpdatedAt && follow.data.hasMore),
    isLoading: () => history.isPending,
    isFetchingPage,
    failure,
    showEarlier: () => extend("desc"),
    showLater: () => extend("asc"),
    start: () => jump("asc"),
    latest: () => jump("desc"),
  };
}

export type JobEventStretch = ReturnType<typeof useJobEventStretch>;
