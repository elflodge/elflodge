import {
  experimental_streamedQuery,
  skipToken,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/solid-query";
import {
  FINAL_JOB_STATUSES,
  asError,
  type Job,
  type JobEventOrder,
  type JobEventsPage,
  type JobStatus,
} from "contract";
import { createEffect, createMemo, createSignal } from "solid-js";

import { readJobEvent } from "./job-event-record.ts";
import { REFRESH_INTERVAL_MS, orpc, refused } from "./query.ts";

// The contract allows at most 100 Events per read.
const PAGE_SIZE = 100;

type FollowedPage = JobEventsPage & { endedAt?: number };

function withEnding(page: JobEventsPage, status: JobStatus, endedAt?: number): FollowedPage {
  // A job read before this page may still say running when the Runner has just ended.
  // The hub takes endedAt from its closing Event, or records an end itself without an Event.
  if (status === page.status) return { ...page, endedAt };
  const last = page.events.at(-1);
  const end =
    last?.type === "entry" && last.record.kind === `elflodge.job.${page.status}`
      ? readJobEvent(last).at
      : undefined;
  return { ...page, endedAt: end?.getTime() };
}

function historyOptions(id: string, order: JobEventOrder) {
  return orpc.jobs.events.infiniteOptions({
    input: (after: number) => ({
      id,
      order,
      after,
      limit: PAGE_SIZE,
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
      query.state.error && !refused(query.state.error) && !query.state.data
        ? REFRESH_INTERVAL_MS
        : false,
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
    const cursor = tailCursor();
    const id = job().id;
    const input =
      cursor === undefined
        ? skipToken
        : { id, order: "asc" as const, after: cursor, limit: PAGE_SIZE };
    const last = order() === "asc" && cursor !== undefined ? pages().at(-1) : undefined;
    const initial: FollowedPage = {
      events: [],
      hasMore: false,
      status: last?.status ?? job().status,
    };
    return {
      queryKey: orpc.jobs.events.streamedKey({ input }),
      enabled: enabled() && cursor !== undefined,
      // An ascending history page that reached the end already supplied its status and cursor.
      initialData: last
        ? { ...withEnding(last, job().status, job().endedAt?.getTime()), events: [] }
        : undefined,
      staleTime: "static",
      gcTime: 0,
      queryFn: experimental_streamedQuery<FollowedPage, FollowedPage>({
        refetchMode: "append",
        initialValue: initial,
        reducer: (previous, page) => ({
          ...page,
          events: page.events.length ? previous.events.concat(page.events) : previous.events,
        }),
        async *streamFn(context) {
          let after =
            context.client.getQueryData<FollowedPage>(context.queryKey)?.events.at(-1)?.id ??
            cursor ??
            0;
          for (;;) {
            const status = job().status;
            const endedAt = job().endedAt?.getTime();
            const read = orpc.jobs.events.queryOptions({
              input: { id, order: "asc", after, limit: PAGE_SIZE },
            });
            const page = await read.queryFn({ ...context, queryKey: read.queryKey });
            yield withEnding(page, status, endedAt);
            const newest = page.events.at(-1);
            if (!page.hasMore || !newest) return;
            after = newest.id;
          }
        },
      }),
      refetchInterval: ({ state }) => {
        if (state.error) return refused(state.error) ? false : REFRESH_INTERVAL_MS;
        return state.data && !state.data.hasMore && FINAL_JOB_STATUSES.includes(state.data.status)
          ? false
          : REFRESH_INTERVAL_MS;
      },
    };
  });
  // A job can end and resume between two job reads, even ending again with the same status.
  createEffect(jobReadAt, (readAt) => {
    if (
      !enabled() ||
      tailCursor() === undefined ||
      follow.isFetching ||
      follow.isError ||
      !follow.dataUpdatedAt ||
      readAt <= follow.dataUpdatedAt
    )
      return;
    const last = follow.data;
    if (
      !last.hasMore &&
      FINAL_JOB_STATUSES.includes(last.status) &&
      (last.status !== job().status || job().endedAt?.getTime() !== last.endedAt)
    )
      void follow.refetch();
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
