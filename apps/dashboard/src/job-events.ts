import { ORPCError } from "@orpc/client";
import {
  experimental_streamedQuery,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/solid-query";
import { asError, problemOf, type JobEventsPage } from "contract";
import { createMemo, createSignal, deep, flush, latest, onCleanup, resolve, until } from "solid-js";

import { REFRESH_INTERVAL_MS, orpc, refused } from "./query.ts";

// The contract allows at most 100 Events per read.
const PAGE_SIZE = 100;

export type PagingDirection = "earlier" | "later";

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
export function useJobEvents(id: () => string, enabled: () => boolean) {
  const client = useQueryClient();
  const ownerLifetime = new AbortController();
  onCleanup(() => ownerLifetime.abort());
  const [direction, setDirection] = createSignal<PagingDirection>("earlier");
  const [isReadingPage, setReadingPage] = createSignal(false);
  const [jumpFailure, setJumpFailure] = createSignal<{ side: PagingDirection; error: Error }>();
  const historyRequest = createMemo(() => historyOptions(id(), direction()));
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

  const historyMissing = () =>
    problemOf(history.error)?.status === 404 || problemOf(jumpFailure()?.error)?.status === 404;
  const canFollow = () => enabled() && tailCursor() !== undefined && !historyMissing();
  const followInput = createMemo(() => ({
    id: id(),
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
    const mayFollow = canFollow();
    const initial: JobEventsPage = { events: [], hasMore: false };
    return {
      queryKey: followKey(),
      enabled: ({ state }) => mayFollow && !(state.error && refused(state.error)),
      placeholderData: initial,
      gcTime: 0,
      queryFn: experimental_streamedQuery<JobEventsPage, JobEventsPage>({
        refetchMode: "append",
        initialValue: initial,
        reducer: (previous, page) => ({
          hasMore: page.hasMore,
          events: page.events.length ? previous.events.concat(page.events) : previous.events,
        }),
        async *streamFn(context) {
          let after =
            context.client.getQueryData<JobEventsPage>(context.queryKey)?.events.at(-1)?.id ??
            cursor ??
            0;
          for (;;) {
            const page = await orpc.jobs.events.call(
              { ...input, after },
              { signal: context.signal },
            );
            // An older hub can answer during a Workers rollout. Its tail has only status,
            // so hand the record back to jobs.get as for any other refused Events read.
            if (!page.hasMore && !page.job)
              throw new ORPCError("INTERNAL_SERVER_ERROR", {
                message: "The Events answer at the end of the journal did not include the job.",
              });
            if (page.job) {
              const queryKey = orpc.jobs.get.queryKey({ input: { id: input.id } });
              // Disabling the job observer stops its polls, but leaves an active fetch on the wire.
              await client.cancelQueries({ queryKey, exact: true });
              if (context.signal.aborted || !canFollow()) return;
              client.setQueryData(queryKey, page.job);
            }
            yield page;
            const newest = page.events.at(-1);
            if (!newest || !page.hasMore) return;
            after = newest.id;
          }
        },
      }),
      refetchInterval: REFRESH_INTERVAL_MS,
    };
  });
  // The observer dates each streamed cache write. Read that accumulated page directly:
  // Solid can hold its data projection while the separate job observer settles a refetch.
  const followed = createMemo(() =>
    follow.dataUpdatedAt ? client.getQueryData<JobEventsPage>(followKey()) : undefined,
  );
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
        ...historyOptions(id(), next),
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
    needsJobRead: () => !canFollow() || (!!follow.error && refused(follow.error)),
    isAtLatest: () => canFollow() && !follow.isError && followed()?.hasMore === false,
    isLoading: () => history.isPending,
    isReadingPage,
    failure,
    readPage,
    readFromStart: () => jump("earlier"),
    readLatest: () => jump("later"),
  };
}

export type JobEvents = ReturnType<typeof useJobEvents>;
