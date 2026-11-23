import {
  CancelledError,
  QueryObserver,
  type QueryObserverResult,
  experimental_streamedQuery,
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/solid-query";
import { asError, problemOf, type Job, type JobEventsPage } from "contract";
import {
  createMemo,
  createSignal,
  deep,
  flush,
  from,
  latest,
  onCleanup,
  resolve,
  until,
} from "solid-js";

import { REFRESH_INTERVAL_MS, orpc, refused } from "./query.ts";

// The contract allows at most 100 Events per read.
const PAGE_SIZE = 100;

export type PagingDirection = "earlier" | "later";

type FollowedPage = Pick<JobEventsPage, "events" | "hasMore"> & { hasJob: boolean };

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
  const [replacingHistory, setReplacingHistory] = createSignal(false);
  const [jumpFailure, setJumpFailure] = createSignal<{ side: PagingDirection; error: Error }>();
  async function writeJob(job: Job, signal: AbortSignal) {
    const queryKey = orpc.jobs.get.queryKey({ input: { id: job.id } });
    // Disabling the job observer stops its polls, but leaves an active fetch on the wire.
    await client.cancelQueries({ queryKey, exact: true });
    if (!signal.aborted && !ownerLifetime.signal.aborted) client.setQueryData(queryKey, job);
  }
  function historyOptions(jobId: string, side: PagingDirection) {
    const order = side === "earlier" ? "desc" : "asc";
    const input = (after: number) => ({ id: jobId, order, after, limit: PAGE_SIZE }) as const;
    return orpc.jobs.events.infiniteOptions({
      input,
      initialPageParam: 0,
      async queryFn({ pageParam, signal }) {
        // A history read that can carry the job takes over from the follower. A jump keeps
        // it stopped until the replacement history supplies the cursor for the next poll.
        // Stopping it first also keeps a job from showing an older status than its Events: no
        // answer of the follower, such as one bringing its success, can land while this read
        // runs, to be replaced by the older job in this read's snapshot.
        if (order === "asc" || pageParam === 0) {
          await client.cancelQueries({
            queryKey: orpc.jobs.events.key({ type: "streamed", input: { id: jobId } }),
          });
        }
        const page = await orpc.jobs.events.call(input(pageParam), { signal });
        if (page.job) await writeJob(page.job, signal);
        return page;
      },
      getNextPageParam: (last) => (last.hasMore ? last.events.at(-1)?.id : undefined),
      // These Events are immutable. Rereading every page from the first cursor would move
      // the first Event shown as new Events arrive.
      staleTime: "static",
      gcTime: 0,
    });
  }
  const historyRequest = createMemo(() => historyOptions(id(), direction()));
  const history = useInfiniteQuery(() => ({
    ...historyRequest(),
    enabled: enabled(),
    refetchInterval: (query) =>
      query.state.error && !refused(query.state.error) && !query.state.data
        ? REFRESH_INTERVAL_MS
        : false,
  }));
  // The journal stays readable while either Events request is pending and the job read expires,
  // because `deep` reads every Event inside `latest`.
  const pages = createMemo(() =>
    history.dataUpdatedAt ? latest(() => deep(history.data.pages)) : [],
  );
  const historyEvents = createMemo(() => {
    const events = pages().flatMap((page) => page.events);
    return direction() === "earlier" ? events.toReversed() : events;
  });
  const hasPage = (side: PagingDirection) => direction() === side && history.hasNextPage;
  const tailCursor = createMemo(() =>
    pages().length && !hasPage("later") ? (historyEvents().at(-1)?.id ?? 0) : undefined,
  );

  const historyMissing = () =>
    problemOf(history.error)?.status === 404 || problemOf(jumpFailure()?.error)?.status === 404;
  const canFollow = createMemo(() => enabled() && tailCursor() !== undefined && !historyMissing());
  const tailHasJob = createMemo(
    () => !!(direction() === "earlier" ? pages()[0] : pages().at(-1))?.job,
  );
  // @tanstack/solid-query 6.0.0-rc.6 useBaseQuery.ts returns the fetch promise during a
  // refetch, holding the previous data until the whole stream settles. Observe each reduced
  // page with QueryObserver. Move back to useQuery when its data publishes in-flight chunks.
  const follow = createMemo(() => {
    const cursor = tailCursor();
    const input = { id: id(), order: "asc" as const, after: cursor, limit: PAGE_SIZE };
    const mayFollow = canFollow() && !replacingHistory();
    const initial: FollowedPage = { events: [], hasMore: false, hasJob: false };
    const hasJob = tailHasJob();
    const observer = new QueryObserver<FollowedPage>(client, {
      queryKey: orpc.jobs.events.key({ type: "streamed", input }),
      enabled: ({ state }) => mayFollow && !(state.error && refused(state.error)),
      initialData: cursor !== undefined ? { ...initial, hasJob } : undefined,
      gcTime: 0,
      queryFn: experimental_streamedQuery<JobEventsPage, FollowedPage>({
        refetchMode: "append",
        initialValue: initial,
        reducer: (previous, page) => ({
          hasMore: page.hasMore,
          hasJob: !!page.job,
          events: page.events.length ? previous.events.concat(page.events) : previous.events,
        }),
        async *streamFn(context) {
          let after =
            context.client.getQueryData<FollowedPage>(context.queryKey)?.events.at(-1)?.id ??
            cursor ??
            0;
          for (;;) {
            const page = await orpc.jobs.events.call(
              { ...input, after },
              { signal: context.signal },
            );
            if (page.job) await writeJob(page.job, context.signal);
            yield page;
            const newest = page.events.at(-1);
            if (!newest || !page.hasMore) return;
            after = newest.id;
          }
        },
      }),
      refetchInterval: REFRESH_INTERVAL_MS,
    });
    return from<QueryObserverResult<FollowedPage>>((next) => {
      const unsubscribe = observer.subscribe(next);
      next(observer.getCurrentResult());
      return unsubscribe;
    });
  });
  const followed = () => follow().data;
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
      if (side === "later" && tailCursor() !== undefined && (!followed() || follow().isError)) {
        const result = await follow().refetch({ cancelRefetch: false });
        if (!result.isSuccess) throw result.error;
        if (ownerLifetime.signal.aborted) return false;
        setJumpFailure(undefined);
        return enabled();
      }
      const previousHistoryError = history.error;
      const previousFollowError = follow().error;
      setReplacingHistory(true);
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
          follow().isError &&
          follow().error !== previousFollowError);
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
      // A control's answer cancels a jump still reading, since the job it writes is newer
      // (JobControls): no failure to report, and the history on screen stays.
      if (error instanceof CancelledError) setJumpFailure(undefined);
      else if (!ownerLifetime.signal.aborted) setJumpFailure({ side, error: asError(error) });
      return false;
    } finally {
      setReplacingHistory(false);
      setReadingPage(false);
    }
  }
  async function readPage(side: PagingDirection) {
    if (!enabled() || isReadingPage() || !hasPage(side)) return undefined;
    setReadingPage(true);
    // Disable the button and clear its refusal before a retry suspends the history read.
    flush();
    const pageCount = pages().length;
    try {
      const result = await history.fetchNextPage();
      // Cancelling a fetch with cached pages resolves with those pages (query-core query.ts).
      if (
        !result.isSuccess ||
        result.data.pages.length === pageCount ||
        ownerLifetime.signal.aborted
      )
        return undefined;
      // Query's response can arrive before Solid has committed the replacement for the button.
      await resolve(() => history.data);
      return result.data.pages.at(-1);
    } finally {
      setJumpFailure(undefined);
      setReadingPage(false);
    }
  }
  function failure() {
    const readAt = Math.max(follow().dataUpdatedAt, history.dataUpdatedAt);
    // A failed Latest can also be the history query currently on screen. The edge
    // reports that request; an independent failure to follow still belongs here.
    const read =
      history.isError &&
      !isReadingPage() &&
      !history.isFetchNextPageError &&
      history.error !== jumpFailure()?.error
        ? history
        : follow();
    return read.isError && read.error !== jumpFailure()?.error
      ? {
          error: read.error,
          failedAt: read.errorUpdatedAt,
          readAt,
          follower: read === follow() && tailCursor() !== undefined,
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
    // An older hub can serve a tail without the job during a rollout. Keep following its
    // Events while jobs.get supplies the record until an Events answer carries it again.
    needsJobRead: () => {
      const { error, data } = follow();
      return (
        !canFollow() || (!!error && refused(error)) || (data?.hasMore === false && !data.hasJob)
      );
    },
    isAtLatest: () => canFollow() && !follow().isError && followed()?.hasMore === false,
    isLoading: () => history.isPending,
    isReadingPage,
    failure,
    readPage,
    readFromStart: () => jump("earlier"),
    readLatest: () => jump("later"),
  };
}

export type JobEvents = ReturnType<typeof useJobEvents>;
