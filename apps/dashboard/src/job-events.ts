import {
  experimental_streamedQuery,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/solid-query";
import { FINAL_JOB_STATUSES, asError, type Job, type JobEventsPage } from "contract";
import {
  createEffect,
  createMemo,
  createSignal,
  deep,
  flush,
  latest,
  onCleanup,
  resolve,
  until,
} from "solid-js";

import { readJobEvent } from "./job-event-record.ts";
import { JOB_LIFECYCLE } from "./job-lifecycle.ts";
import { REFRESH_INTERVAL_MS, orpc, refused } from "./query.ts";

// The contract allows at most 100 Events per read.
const PAGE_SIZE = 100;

export type PagingDirection = "earlier" | "later";

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

function historyOptions(id: string, direction: PagingDirection) {
  return orpc.jobs.events.infiniteOptions({
    input: (after: number) => ({
      id,
      order: direction === "earlier" ? "desc" : "asc",
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

/**
 * History and the live follower use separate queries. In @tanstack/query-core 5.107.1,
 * query.ts runs one fetch per query: paging can cancel an active poll or reuse its promise.
 * infiniteQueryBehavior.ts refetches every kept page, and infiniteQueryObserver.ts classifies a
 * paging failure only by direction. A forward poll and a requested forward page need separate errors.
 */
export function useJobEvents(job: () => Job, enabled: () => boolean, jobReadAt: () => number) {
  const client = useQueryClient();
  const ownerLifetime = new AbortController();
  onCleanup(() => ownerLifetime.abort());
  const [direction, setDirection] = createSignal<PagingDirection>("earlier");
  const [isReadingPage, setReadingPage] = createSignal(false);
  const [jumpFailure, setJumpFailure] = createSignal<{ side: PagingDirection; error: Error }>();
  const historyRequest = createMemo(() => historyOptions(job().id, direction()));
  const history = useInfiniteQuery(() => ({
    ...historyRequest(),
    enabled: enabled(),
    refetchInterval: (query) =>
      query.state.error && !refused(query.state.error) && !query.state.data
        ? REFRESH_INTERVAL_MS
        : false,
  }));
  // The journal stays readable while either Events request is pending and the job read expires.
  const pages = createMemo(() =>
    history.dataUpdatedAt ? latest(() => deep(history.data.pages)) : [],
  );
  const historyEvents = createMemo(() => {
    const events = pages().flatMap((page) => page.events);
    return direction() === "earlier" ? events.toReversed() : events;
  });
  const hasPage = (side: PagingDirection) => direction() === side && history.hasNextPage;
  const tailCursor = () =>
    pages().length && !hasPage("later") ? (historyEvents().at(-1)?.id ?? 0) : undefined;

  const followInput = createMemo(() => ({
    id: job().id,
    order: "asc" as const,
    after: tailCursor(),
    limit: PAGE_SIZE,
  }));
  const followKey = createMemo(() =>
    orpc.jobs.events.key({ type: "streamed", input: followInput() }),
  );
  const follow = useQuery(() => {
    const cursor = tailCursor();
    const input = followInput();
    const mayFollow = enabled() && cursor !== undefined;
    const last = direction() === "later" && cursor !== undefined ? pages().at(-1) : undefined;
    const endedAt = last && closingTime(last);
    const initial: FollowedPage = {
      events: [],
      hasMore: false,
      status: last?.status ?? job().status,
    };
    return {
      queryKey: followKey(),
      enabled: ({ state }) =>
        mayFollow &&
        (state.error ? !refused(state.error) : !state.data || !isFinalPage(state.data)),
      // Keep history readable before the first forward answer, including while retrying
      // a refusal or after Start removes the cursor. Only a hub answer dates the data.
      placeholderData: initial,
      // An old page can arrive after another run has ended. Only its own closing Event
      // identifies which ending it shows. Without one, read forward to confirm its cursor.
      initialData:
        last && (!isFinalPage(last) || endedAt !== undefined) ? { ...initial, endedAt } : undefined,
      initialDataUpdatedAt: history.dataUpdatedAt,
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
            // Only a tail answer prompts a fresh job read. History pages may have been
            // held while the job changed, and usage and controls belong to the whole job.
            const jobKey = orpc.jobs.get.queryKey({ input: { id: input.id } });
            const record = context.client.getQueryState(jobKey);
            if (record?.data && record.data.status !== page.status && !context.signal.aborted) {
              void context.client.invalidateQueries(
                { queryKey: jobKey, exact: true },
                { cancelRefetch: !record.isInvalidated },
              );
            }
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
  const followed = createMemo(() =>
    follow.dataUpdatedAt ? latest(() => deep(follow.data)) : undefined,
  );
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
    tailCursor() !== undefined ? (followed()?.events ?? []) : [],
  );
  const events = createMemo(() => historyEvents().concat(liveEvents()));

  const arrivalFirstId = createMemo<number | undefined>(
    (first) =>
      first ??
      (direction() === "earlier"
        ? (pages()[0]?.events.at(-1)?.id ?? liveEvents()[0]?.id)
        : undefined),
  );
  // Latest may replace the arrival page after more than a page of live Events. Walking
  // back past that new page must not reveal an older run opening above the button.
  function firstHeadEventId() {
    const arrival = arrivalFirstId();
    if (arrival === undefined || direction() !== "earlier") return arrival;
    return Math.max(arrival, pages()[0]?.events.at(-1)?.id ?? arrival);
  }

  async function jump(side: PagingDirection) {
    if (!enabled() || isReadingPage()) return false;
    setReadingPage(true);
    const next = side === "earlier" ? "later" : "earlier";
    try {
      // A refused follower stops polling. Resume at its last Event on an explicit
      // Latest so the journal the member already read stays on screen.
      if (side === "later" && tailCursor() !== undefined && (!followed() || follow.isError)) {
        const result = await follow.refetch({ cancelRefetch: false });
        if (!result.isSuccess) throw result.error;
        if (ownerLifetime.signal.aborted) return false;
        await resolve(() => follow.data);
        setJumpFailure(undefined);
        return enabled();
      }
      const previousHistoryError = history.error;
      const previousFollowError = follow.error;
      const answer = await client.infiniteQuery({
        ...historyOptions(job().id, next),
        staleTime: 0,
        pages: 1,
      });
      if (ownerLifetime.signal.aborted) return false;
      setDirection(next);
      // Query resolves the read before Solid commits the new rows. Focus belongs to the
      // requested end, even when an ascending read has already added a newer Event there.
      const firstPage = answer.pages[0];
      const target = firstPage?.events[0]?.id;
      const cursor =
        next === "earlier" ? target : firstPage?.hasMore ? undefined : firstPage?.events.at(-1)?.id;
      // The previous refusal can remain visible until the new rows arrive.
      const historyRereadFailed = () => history.isError && history.error !== previousHistoryError;
      const rereadFailed = () =>
        historyRereadFailed() ||
        (cursor !== undefined &&
          tailCursor() === cursor &&
          follow.isError &&
          follow.error !== previousFollowError);
      await until(
        () => {
          if (!enabled() || rereadFailed() || target === undefined) return true;
          return next === "later"
            ? events().at(0)?.id === target
            : (events().at(-1)?.id ?? 0) >= target;
        },
        { signal: ownerLifetime.signal },
      );
      if (historyRereadFailed()) throw history.error;
      setJumpFailure(undefined);
      return enabled() && !rereadFailed();
    } catch (error) {
      if (!ownerLifetime.signal.aborted) setJumpFailure({ side, error: asError(error) });
      return false;
    } finally {
      setReadingPage(false);
    }
  }
  async function readPage(side: PagingDirection) {
    if (!enabled() || isReadingPage() || !hasPage(side)) return undefined;
    setReadingPage(true);
    // Disable the button and clear its refusal before a retry suspends the history read.
    flush();
    try {
      const result = await history.fetchNextPage();
      if (!result.isSuccess || ownerLifetime.signal.aborted) return undefined;
      // Query's response can arrive before Solid has committed the replacement for the button.
      await resolve(() => history.data);
      return result.data.pages.at(-1);
    } finally {
      setJumpFailure(undefined);
      setReadingPage(false);
    }
  }
  function failure() {
    const readAt = Math.max(follow.dataUpdatedAt, history.dataUpdatedAt);
    // A failed Latest can also be the history query currently on screen. The edge
    // reports that request; an independent failure to follow still belongs here.
    const read =
      history.isError &&
      !isReadingPage() &&
      !history.isFetchNextPageError &&
      history.error !== jumpFailure()?.error
        ? history
        : follow;
    return read.isError && read.error !== jumpFailure()?.error
      ? {
          error: read.error,
          failedAt: read.errorUpdatedAt,
          readAt,
          follower: read === follow && tailCursor() !== undefined,
        }
      : undefined;
  }

  return {
    events,
    liveEvents,
    firstHeadEventId,
    hasPage,
    usedUp: (side: PagingDirection) =>
      direction() === side && pages().length > 1 && !history.hasNextPage,
    pageError: (side: PagingDirection) => {
      const failed = jumpFailure();
      if (failed?.side === side) return { error: failed.error, jump: true };
      return direction() === side && !isReadingPage() && history.isFetchNextPageError
        ? { error: history.error, jump: false }
        : undefined;
    },
    isAtLatest: () =>
      !!pages().length && !hasPage("later") && !follow.isError && followed()?.hasMore === false,
    isLoading: () => history.isPending,
    isReadingPage,
    failure,
    readPage,
    readFromStart: () => jump("earlier"),
    readLatest: () => jump("later"),
  };
}

export type JobEvents = ReturnType<typeof useJobEvents>;
