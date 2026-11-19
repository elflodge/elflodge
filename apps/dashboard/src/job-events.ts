import {
  experimental_streamedQuery,
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
} from "contract";
import { createEffect, createMemo, createSignal, flush, onCleanup, resolve, until } from "solid-js";

import { readJobEvent } from "./job-event-record.ts";
import { JOB_LIFECYCLE } from "./job-lifecycle.ts";
import { REFRESH_INTERVAL_MS, orpc, refused } from "./query.ts";

// The contract allows at most 100 Events per read.
const PAGE_SIZE = 100;

type FollowedPage = JobEventsPage & { endedAt?: number };

function isFinalPage(page: JobEventsPage) {
  return !page.hasMore && FINAL_JOB_STATUSES.includes(page.status);
}

function closingTime(page: JobEventsPage) {
  if (!isFinalPage(page)) return undefined;
  const last = page.events.findLast(
    (event) => event.type === "entry" && JOB_LIFECYCLE.has(event.record.kind),
  );
  const closing = last && readJobEvent(last);
  return closing?.lifecycle?.finalStatus === page.status ? closing.at?.getTime() : undefined;
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
    // the first cursor, which would move the first Event shown as new Events arrive.
    staleTime: "static",
    gcTime: 0,
  });
}

/** The member extends one end on request. The other follows the journal once caught up. */
export function useJobEvents(job: () => Job, enabled: () => boolean, jobReadAt: () => number) {
  const client = useQueryClient();
  const ownerLifetime = new AbortController();
  onCleanup(() => ownerLifetime.abort());
  const [order, setOrder] = createSignal<JobEventOrder>("desc");
  const [readingPage, setReadingPage] = createSignal(false);
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
    const input = { id, order: "asc" as const, after: cursor, limit: PAGE_SIZE };
    const mayFollow = enabled() && cursor !== undefined;
    const last = order() === "asc" && cursor !== undefined ? pages().at(-1) : undefined;
    const endedAt = last && closingTime(last);
    const initial: FollowedPage = {
      events: [],
      hasMore: false,
      status: last?.status ?? job().status,
    };
    return {
      queryKey: orpc.jobs.events.key({ type: "streamed", input }),
      enabled: ({ state }) =>
        mayFollow &&
        (state.error ? !refused(state.error) : !state.data || !isFinalPage(state.data)),
      // An old page can arrive after another run has ended. Only its own closing Event
      // identifies which ending it shows. Without one, read forward to confirm its cursor.
      initialData:
        last && (!isFinalPage(last) || endedAt !== undefined) ? { ...initial, endedAt } : undefined,
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
            const jobEndBeforeRead = job().endedAt?.getTime();
            const page = await orpc.jobs.events.call(
              { ...input, after },
              { signal: context.signal },
            );
            const newest = page.events.at(-1);
            const end = closingTime(page);
            yield {
              ...page,
              endedAt: end ?? (!newest && status === page.status ? jobEndBeforeRead : undefined),
            };
            // Drain the backlog now. A nonempty final page without its closing Event
            // needs another read at its newest cursor to confirm which ending it saw.
            if (!newest || (!page.hasMore && (!isFinalPage(page) || end !== undefined))) return;
            after = newest.id;
          }
        },
      }),
      refetchInterval: REFRESH_INTERVAL_MS,
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
      isFinalPage(last) &&
      (last.status !== job().status || job().endedAt?.getTime() !== last.endedAt)
    )
      void follow.refetch();
  });
  const liveEvents = createMemo(() =>
    tailCursor() !== undefined && follow.dataUpdatedAt ? follow.data.events : [],
  );
  const events = createMemo(() => historyEvents().concat(liveEvents()));

  async function jump(next: JobEventOrder) {
    if (!enabled() || readingPage()) return false;
    setReadingPage(true);
    setJumpFailure(undefined);
    try {
      const previousHistoryError = history.error;
      const previousFollowError = follow.error;
      const answer = await client.infiniteQuery({
        ...historyOptions(job().id, next),
        staleTime: 0,
        pages: 1,
      });
      if (ownerLifetime.signal.aborted) return false;
      setOrder(next);
      // Query resolves the read before Solid commits the new rows. Focus belongs to the
      // requested end, even when an ascending read has already added a newer Event there.
      const firstPage = answer.pages[0];
      const target = firstPage?.events[0]?.id;
      const cursor =
        next === "desc" ? target : firstPage?.hasMore ? undefined : firstPage?.events.at(-1)?.id;
      // The previous refusal can remain visible until the new rows arrive.
      const rereadFailed = () =>
        (history.isError && history.error !== previousHistoryError) ||
        (cursor !== undefined &&
          tailCursor() === cursor &&
          follow.isError &&
          follow.error !== previousFollowError);
      await until(
        () => {
          if (!enabled() || rereadFailed() || target === undefined) return true;
          return next === "asc"
            ? events().at(0)?.id === target
            : (events().at(-1)?.id ?? 0) >= target;
        },
        { signal: ownerLifetime.signal },
      );
      return enabled() && !rereadFailed();
    } catch (error) {
      if (!ownerLifetime.signal.aborted)
        setJumpFailure({ error: asError(error), failedAt: Date.now() });
      return false;
    } finally {
      setReadingPage(false);
    }
  }
  async function extend(direction: JobEventOrder) {
    if (!enabled() || order() !== direction || isFetchingPage() || !history.hasNextPage)
      return undefined;
    setJumpFailure(undefined);
    setReadingPage(true);
    // Disable the button and clear its refusal before a retry suspends the history read.
    flush();
    try {
      const result = await history.fetchNextPage();
      if (!result.isSuccess || ownerLifetime.signal.aborted) return undefined;
      // Query's response can arrive before Solid has committed the replacement for the button.
      return (await resolve(() => history.data)).pages.at(-1);
    } finally {
      setReadingPage(false);
    }
  }
  const isFetchingPage = () => readingPage() || history.isFetching;
  function failure() {
    const readAt = Math.max(follow.dataUpdatedAt, history.dataUpdatedAt);
    const failed = jumpFailure();
    if (failed) return { ...failed, readAt };
    const read = history.isError && !history.isFetchNextPageError ? history : follow;
    return read.isError ? { error: read.error, failedAt: read.errorUpdatedAt, readAt } : undefined;
  }

  return {
    events,
    liveEvents,
    hasEarlier: () => order() === "desc" && history.hasNextPage,
    pagedToEnd: () => (pages().length > 1 && !history.hasNextPage ? order() : undefined),
    hasLater,
    pageError: () => (!readingPage() && history.isFetchNextPageError ? history.error : undefined),
    isAtLatest: () =>
      !!pages().length && !hasLater() && !(follow.dataUpdatedAt && follow.data.hasMore),
    isLoading: () => history.isPending,
    isFetchingPage,
    failure,
    readEarlier: () => extend("desc"),
    readLater: () => extend("asc"),
    readFromStart: () => jump("asc"),
    readLatest: () => jump("desc"),
  };
}

export type JobEvents = ReturnType<typeof useJobEvents>;
