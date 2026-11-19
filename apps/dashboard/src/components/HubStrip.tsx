import type { JSX } from "@solidjs/web";
import type { UseQueryResult } from "@tanstack/solid-query";
import { useQuery } from "@tanstack/solid-query";
import { Errored, Loading, Show } from "solid-js";

import { TIME_ZONED, formatCount, plural } from "../format.ts";
import { orpc } from "../query.ts";
import { Instant } from "./Time.tsx";

// Bull Board polls its queue counts and jobs at this interval while the dashboard is open.
// https://github.com/felixmosh/bull-board/blob/4d98710f7e8bee0cfcd5a158caadf9fd109b4cb1/website/docs/recipes/change-polling-interval.md
const REFRESH = 5_000;

/** What the hub says now about the Organization's Runners and unfinished jobs. */
export function HubStrip() {
  const runners = useQuery(() => orpc.runners.list.queryOptions({ refetchInterval: REFRESH }));
  const counts = useQuery(() =>
    orpc.jobs.counts.queryOptions({ input: {}, refetchInterval: REFRESH }),
  );

  return (
    <section class="hubstrip" aria-label="The hub now">
      <ul class="hubstate">
        <Show
          when={!(runners.isPaused || counts.isPaused)}
          fallback={<Failed>The hub cannot be read: this browser is offline.</Failed>}
        >
          <Read query={runners} what="The Runners">
            {(list) => {
              const connected = () => list().filter((runner) => runner.connected).length;
              // Runners there are, none of them connected: their jobs' statuses are unknown.
              const noneConnected = () => list().length > 0 && connected() === 0;
              return (
                <li class={noneConnected() ? "hub-unknown" : undefined}>
                  <span
                    class={connected() > 0 ? "mark mark-connected" : "mark mark-disconnected"}
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
                    class={
                      read().jobCounts.running > read().statusUnknownJobs
                        ? "mark mark-running"
                        : "mark mark-running is-out"
                    }
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

/** One read's figures, or the time its latest read failed. */
function Read<T>(props: {
  query: UseQueryResult<T>;
  what: string;
  children: (data: () => T) => JSX.Element;
}) {
  return (
    <Show when={!(props.query.isFetching && Date.now() - props.query.dataUpdatedAt > 2 * REFRESH)}>
      <Show
        when={!props.query.isError}
        fallback={
          <Failed>
            {props.what} could not be read at{" "}
            <Instant value={new Date(props.query.errorUpdatedAt)} format={TIME_ZONED} />.
          </Failed>
        }
      >
        <Errored fallback={<Failed>{props.what} could not be shown.</Failed>}>
          <Loading fallback={null}>
            <Show when={props.query.data}>{(data) => props.children(data)}</Show>
          </Loading>
        </Errored>
      </Show>
    </Show>
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
