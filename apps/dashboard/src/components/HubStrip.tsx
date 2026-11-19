import type { JSX } from "@solidjs/web";
import type { UseQueryResult } from "@tanstack/solid-query";
import { useQuery } from "@tanstack/solid-query";
import { Errored, Loading, Show } from "solid-js";

import { apiFailureMessage } from "../api-client.ts";
import { TIME, formatCount, plural } from "../format.ts";
import { orpc } from "../query.ts";
import { Instant } from "./Time.tsx";

/** How often the strip reads the hub again while the page is visible. */
const REFRESH = 15_000;

/**
 * Under the bar, what the hub says now about the Organization's Runners and unfinished jobs, read
 * again every few seconds while the page is visible. A read that fails says so in its place, and
 * the bar stays.
 */
export function HubStrip() {
  const runners = useQuery(() => ({
    ...orpc.runners.list.queryOptions(),
    refetchInterval: REFRESH,
  }));
  const counts = useQuery(() => ({
    ...orpc.jobs.counts.queryOptions({ input: {} }),
    refetchInterval: REFRESH,
  }));

  return (
    <section class="hubstrip" aria-label="The hub now">
      <ul class="hubstate">
        <Read query={runners} what="The Runners">
          {(list) => {
            const connected = () => list().filter((runner) => runner.connected).length;
            return (
              <li>
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
                <span class="mark mark-running" aria-hidden="true" />
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
                  {formatCount(read().statusUnknownJobs)} unconfirmed
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
    // Errored keeps the bar if drawing the items fails all the same.
    <Errored fallback={<Failed query={props.query} what={props.what} />}>
      <Loading fallback={null}>
        {/* While the latest read has failed, what an earlier one read is not shown as current.
            Until the first answer, reading the data waits in Loading. */}
        <Show
          when={!props.query.isError && props.query.data}
          fallback={<Failed query={props.query} what={props.what} />}
        >
          {(data) => props.children(data)}
        </Show>
      </Loading>
    </Errored>
  );
}

/** What the strip could not read, and when, with the hub's words in its title. */
function Failed(props: { query: UseQueryResult; what: string }) {
  return (
    <li
      class="hub-failed"
      title={props.query.error ? apiFailureMessage(props.query.error) : undefined}
    >
      <span class="mark mark-failed" aria-hidden="true" />
      <span>
        {props.what} could not be read at{" "}
        <Instant value={new Date(props.query.errorUpdatedAt || Date.now())} format={TIME} />.
      </span>
    </li>
  );
}
