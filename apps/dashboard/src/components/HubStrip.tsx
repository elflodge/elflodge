import type { JSX } from "@solidjs/web";
import type { UseQueryResult } from "@tanstack/solid-query";
import { useQuery } from "@tanstack/solid-query";
import { Link } from "@tanstack/solid-router";
import { Errored, Loading, Match, Show, Switch, createMemo } from "solid-js";

import { TIME_ZONED, formatCount, plural } from "../format.ts";
import { REFRESH_INTERVAL_MS, orpc } from "../query.ts";
import { browserOnline, readIsFresh } from "../read-freshness.ts";
import { Instant } from "./Instant.tsx";

/** What the hub says now about the Organization's Runners and unfinished jobs. */
export function HubStrip() {
  const online = browserOnline();
  const runners = useQuery(() =>
    orpc.runners.list.queryOptions({ refetchInterval: REFRESH_INTERVAL_MS }),
  );
  const counts = useQuery(() =>
    orpc.jobs.counts.queryOptions({ input: {}, refetchInterval: REFRESH_INTERVAL_MS }),
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
                  <Link to="/runners">
                    <span
                      class={[
                        "mark",
                        {
                          "mark-connected": connected() > 0,
                          "mark-disconnected": connected() === 0,
                        },
                      ]}
                      aria-hidden="true"
                    />
                    {list().length === 0
                      ? "No Runners"
                      : `Runners ${formatCount(connected())} of ${formatCount(list().length)} connected`}
                  </Link>
                </li>
              );
            }}
          </Read>
          <Read query={counts} what="The job counts">
            {(read) => {
              const running = () => read().jobCounts.running;
              const allRunningUnknown = () =>
                running() > 0 && running() === read().statusUnknownJobCounts.running;
              const unknownTotal = () =>
                read().statusUnknownJobCounts.queued + read().statusUnknownJobCounts.running;
              return (
                <>
                  {/* A count of running jobs may say agents (CONTEXT.md). */}
                  <li class={{ "hub-unknown": allRunningUnknown() }}>
                    <Link
                      activeOptions={{ exact: true }}
                      to="/jobs"
                      search={{ status: ["running"] }}
                    >
                      <span
                        class={[
                          "mark",
                          allRunningUnknown() ? "mark-unknown" : "mark-running",
                          { "is-out": running() === 0 },
                        ]}
                        aria-hidden="true"
                      />
                      {formatCount(running())} {plural(running(), "agent", "agents")} running
                      {allRunningUnknown() && ", status unknown"}
                    </Link>
                  </li>
                  <li>
                    <Link
                      activeOptions={{ exact: true }}
                      to="/jobs"
                      search={{ status: ["queued"] }}
                    >
                      <span class="mark mark-queued" aria-hidden="true" />
                      {formatCount(read().jobCounts.queued)} queued
                    </Link>
                  </li>
                  <Show when={read().jobCounts.paused > 0}>
                    <li>
                      <Link
                        activeOptions={{ exact: true }}
                        to="/jobs"
                        search={{ status: ["paused"] }}
                      >
                        <span class="mark mark-paused" aria-hidden="true" />
                        {formatCount(read().jobCounts.paused)} paused
                      </Link>
                    </li>
                  </Show>
                  <Show when={unknownTotal() > 0}>
                    <li class="hub-unknown">
                      <Link
                        activeOptions={{ exact: true }}
                        to="/jobs"
                        search={{ statusUnknown: true }}
                      >
                        <span class="mark mark-unknown" aria-hidden="true" />
                        {formatCount(unknownTotal())} status unknown
                      </Link>
                    </li>
                  </Show>
                </>
              );
            }}
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
  const fresh = readIsFresh(() => props.query.dataUpdatedAt);

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
      <Match when={props.query.dataUpdatedAt} keyed>
        {(answeredAt) => (
          <li class="hub-unknown">
            <span class="mark mark-unknown" aria-hidden="true" />
            <span>
              {props.what} have not been read since{" "}
              <Instant value={new Date(answeredAt)} format={TIME_ZONED} />.
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
