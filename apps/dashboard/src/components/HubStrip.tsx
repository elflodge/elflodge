import type { JSX } from "@solidjs/web";
import type { UseQueryResult } from "@tanstack/solid-query";
import { focusManager, onlineManager, useQuery } from "@tanstack/solid-query";
import { Errored, Loading, Match, Show, Switch, createMemo, from } from "solid-js";

import { TIME_ZONED, formatCount, plural } from "../format.ts";
import { orpc } from "../query.ts";
import { Instant } from "./Instant.tsx";

// Bull Board polls its queue counts and jobs at this interval while the dashboard is open.
// https://github.com/felixmosh/bull-board/blob/4d98710f7e8bee0cfcd5a158caadf9fd109b4cb1/website/docs/recipes/change-polling-interval.md
const REFRESH = 5_000;
// The smallest round cutoff beyond the poll and retries (5 + 1 + 2 + 4 seconds) lets a fast outage
// go straight from figures to failure. An unmeasured starting value; revisit with either policy.
const MAX_ANSWER_AGE = 15_000;

/** What the hub says now about the Organization's Runners and unfinished jobs. */
export function HubStrip() {
  const online = createMemo(() =>
    from<boolean>((next) => {
      next(onlineManager.isOnline());
      return onlineManager.subscribe(next);
    }),
  );
  const runners = useQuery(() => orpc.runners.list.queryOptions({ refetchInterval: REFRESH }));
  const counts = useQuery(() =>
    orpc.jobs.counts.queryOptions({ input: {}, refetchInterval: REFRESH }),
  );

  return (
    <section class="hubstrip" aria-label="The hub now">
      <ul class="hubstate">
        <Show
          when={online()}
          fallback={<Failed>The hub cannot be read: this browser is offline.</Failed>}
        >
          <Read query={runners} what="The Runners">
            {(list) => {
              const connected = createMemo(
                () => list().filter((runner) => runner.connected).length,
              );
              // Runners there are, none of them connected: their jobs' statuses are unknown.
              const noneConnected = () => list().length > 0 && connected() === 0;
              return (
                <li class={{ "hub-unknown": noneConnected() }}>
                  <span
                    class={[
                      "mark",
                      { "mark-connected": connected() > 0, "mark-disconnected": connected() === 0 },
                    ]}
                    aria-hidden="true"
                  />
                  {list().length === 0
                    ? "No Runners"
                    : `Runners ${formatCount(connected())} of ${formatCount(list().length)} connected`}
                </li>
              );
            }}
          </Read>
          <Read query={counts} what="The job counts">
            {(read) => (
              <>
                {/* A count of running jobs may say agents (CONTEXT.md). */}
                <li>
                  {/* Unknown jobs can be queued or running. Light the lamp only for a known running job. */}
                  <span
                    class={[
                      "mark mark-running",
                      { "is-out": read().jobCounts.running <= read().statusUnknownJobs },
                    ]}
                    aria-hidden="true"
                  />
                  {formatCount(read().jobCounts.running)}{" "}
                  {plural(read().jobCounts.running, "agent", "agents")} running
                </li>
                <li>
                  <span class="mark mark-queued" aria-hidden="true" />
                  {formatCount(read().jobCounts.queued)} queued
                </li>
                <Show when={read().jobCounts.paused > 0}>
                  <li>
                    <span class="mark mark-paused" aria-hidden="true" />
                    {formatCount(read().jobCounts.paused)} paused
                  </li>
                </Show>
                <Show when={read().statusUnknownJobs > 0}>
                  <li class="hub-unknown">
                    <span class="mark mark-unknown" aria-hidden="true" />
                    {formatCount(read().statusUnknownJobs)} status unknown
                  </li>
                </Show>
              </>
            )}
          </Read>
        </Show>
      </ul>
    </section>
  );
}

/** One read's current figures, or when it last failed or answered. */
function Read<T>(props: {
  query: UseQueryResult<T>;
  what: string;
  children: (data: () => T) => JSX.Element;
}) {
  const fresh = createMemo(() => {
    const answeredAt = props.query.dataUpdatedAt;
    const expiresAt = answeredAt + MAX_ANSWER_AGE;
    if (!answeredAt || Date.now() >= expiresAt) return false;
    // Wake once at expiry and recheck on visibility changes because hidden tabs throttle timers.
    return from<boolean>((next) => {
      const check = () => next(Date.now() < expiresAt);
      check();
      const timer = setTimeout(() => next(false), Math.max(0, expiresAt - Date.now()));
      const unsubscribe = focusManager.subscribe(check);
      return () => {
        clearTimeout(timer);
        unsubscribe();
      };
    });
  });

  return (
    <Switch>
      {/* Both timestamps come from the same clock, which we assume does not step back between reads. */}
      <Match when={props.query.errorUpdatedAt > props.query.dataUpdatedAt}>
        <Failed>
          {props.what} could not be read at{" "}
          <Instant value={new Date(props.query.errorUpdatedAt)} format={TIME_ZONED} />.
        </Failed>
      </Match>
      <Match when={fresh()}>
        <Errored fallback={<Failed>{props.what} could not be shown.</Failed>}>
          <Loading fallback={null}>
            <Show when={props.query.data}>{(data) => props.children(data)}</Show>
          </Loading>
        </Errored>
      </Match>
      <Match when={props.query.dataUpdatedAt}>
        {(answeredAt) => (
          <li class="hub-unknown">
            <span class="mark mark-unknown" aria-hidden="true" />
            <span>
              {props.what} have not been read since{" "}
              <Instant value={new Date(answeredAt())} format={TIME_ZONED} />.
            </span>
          </li>
        )}
      </Match>
    </Switch>
  );
}

/** The strip has room for one short line about the failure. */
function Failed(props: { children: JSX.Element }) {
  return (
    <li class="hub-failed">
      <span class="mark mark-failed" aria-hidden="true" />
      <span>{props.children}</span>
    </li>
  );
}
