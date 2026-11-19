import type { JSX } from "@solidjs/web";
import type { UseQueryResult } from "@tanstack/solid-query";
import { useQuery } from "@tanstack/solid-query";
import { Errored, Loading, Show } from "solid-js";

import { TIME_ZONED, formatCount, plural } from "../format.ts";
import { orpc } from "../query.ts";
import { Instant } from "./Time.tsx";

/**
 * Like Amazon Connect's real-time metrics, update counts every 15 seconds on an active page.
 * https://docs.aws.amazon.com/connect/latest/adminguide/rtm-refresh.html
 */
const REFRESH = 15_000;

/**
 * Under the bar, what the hub says now about the Organization's Runners and unfinished jobs, read
 * again every 15 seconds while the page is visible. A read that fails says so in its place, and
 * the bar stays.
 */
export function HubStrip() {
  const runners = useQuery(() => orpc.runners.list.queryOptions({ refetchInterval: REFRESH }));
  const counts = useQuery(() =>
    orpc.jobs.counts.queryOptions({ input: {}, refetchInterval: REFRESH }),
  );

  return (
    <section class="hubstrip" aria-label="The hub now">
      <ul class="hubstate">
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
                {/* The lamp is for what is live: none running lights nothing. */}
                <span
                  class={
                    read().jobCounts.running > 0 ? "mark mark-running" : "mark mark-running is-zero"
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
      </ul>
    </section>
  );
}

/**
 * The strip's items for one read: nothing until its first answer, then `children` with what it
 * read, or, while its latest read has failed, what could not be read and when.
 */
function Read<T>(props: {
  query: UseQueryResult<T>;
  what: string;
  children: (data: () => T) => JSX.Element;
}) {
  return (
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
