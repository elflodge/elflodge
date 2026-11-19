import { Link } from "@tanstack/solid-router";
import { JOB_PAUSED, JOB_RECOVERED, JOB_RESUMED, JOB_SUCCEEDED, type Job } from "contract";
import { For, Show, createEffect, createMemo, createSignal, flush } from "solid-js";

import { hubFailureMessage } from "../api-client.ts";
import { DAY_YEAR, TIME_SECONDS, formatCount, plural } from "../format.ts";
import type { ReadJobEvent } from "../job-event-record.ts";
import { JobEventRow } from "../job-event-row.tsx";
import type { JobEventStretch } from "../job-event-stretch.ts";
import type { JobEventGroups } from "../job-runs.ts";
import { FailedReadNotice } from "./FailedReadNotice.tsx";
import { Instant } from "./Instant.tsx";
import { JobActivity } from "./JobActivity.tsx";
import { RunHeading } from "./JobRun.tsx";

function linkTo(id?: number) {
  return id === undefined ? null : document.getElementById(`event-${id}`);
}

function JumpGroup(props: {
  name: string;
  multiple: string;
  rows: ReadJobEvent[];
  content?: boolean;
}) {
  return (
    <Show when={props.rows.length}>
      <span class={{ "jump-content": !!props.content }}>
        {formatCount(props.rows.length)} {plural(props.rows.length, props.name, props.multiple)}:
        <For each={props.rows} keyed={(row) => row.id}>
          {(row) => (
            <>
              {" "}
              <a href={`#event-${row().id}`} aria-label={`${props.name}, Event ${row().id}`}>
                {row().id}
              </a>
            </>
          )}
        </For>
      </span>
    </Show>
  );
}

const MOMENTS: ReadonlyMap<string, string> = new Map([
  [JOB_PAUSED, "Paused"],
  [JOB_RESUMED, "Resumed"],
  [JOB_RECOVERED, "Recovered"],
]);

export function JobTimeline(props: {
  job: Job;
  running: boolean;
  stretch: JobEventStretch;
  groups: JobEventGroups;
}) {
  const stretch = props.stretch;
  const rows = () => props.groups.events;
  const first = () => rows().at(0);
  const last = () => rows().at(-1);
  const running = () => props.running && stretch.isAtLatest();
  let timeline: HTMLOListElement | undefined;
  let everything: HTMLInputElement | undefined;
  const [atEnd, setAtEnd] = createSignal(false);
  const [seen, setSeen] = createSignal(0);
  const arrivals = stretch.liveEvents;
  const newestArrival = () => arrivals().at(-1)?.id ?? 0;
  const unread = createMemo(() => (atEnd() ? [] : arrivals().filter((row) => row.id > seen())));
  const newestUnreadTime = () =>
    unread().length
      ? rows().findLast((row) => row.id >= (unread()[0]?.id ?? 0) && row.at)?.at
      : undefined;

  // The live row itself is the end, even on a screen that cannot fit its whole report.
  createEffect(
    () => (running() ? "latest" : last()?.id),
    () => {
      const end = timeline?.lastElementChild;
      if (!end) return undefined;
      const observer = new IntersectionObserver(([entry]) => {
        setAtEnd(entry.isIntersecting);
        if (entry.isIntersecting) setSeen(newestArrival());
      });
      observer.observe(end);
      return () => observer.disconnect();
    },
  );

  createEffect(newestArrival, (id) => {
    if (atEnd() || !id) setSeen(id);
  });

  function reveal(target: HTMLElement | null) {
    if (target && !target.getClientRects().length && everything) everything.checked = true;
    target?.scrollIntoView({ block: "center" });
    target?.focus({ preventScroll: true });
  }
  async function jump(toStart: boolean) {
    if (toStart && stretch.hasEarlier() && !(await stretch.start())) return;
    if (!toStart && stretch.hasLater() && !(await stretch.latest())) return;
    flush();
    reveal(
      toStart ? linkTo(first()?.id) : (document.getElementById("latest") ?? linkTo(last()?.id)),
    );
  }
  async function earlier() {
    const anchor =
      timeline &&
      [...timeline.querySelectorAll<HTMLElement>(".ev-id")].find(
        (el) => el.getClientRects().length,
      );
    const top = anchor?.getBoundingClientRect().top;
    const oldest = first()?.id;
    if (!(await stretch.showEarlier())) return;
    flush();
    // A browser may anchor to the pressed button or a heading. Preserve the particular Event
    // the member was reading, compensating only for the movement the browser actually left.
    if (anchor && top !== undefined && anchor.isConnected) {
      const preservePosition = () => window.scrollBy(0, anchor.getBoundingClientRect().top - top);
      preservePosition();
      // Long previews acquire their disclosure button when ResizeObserver measures the new rows.
      // Its callback runs after animation callbacks and before paint. Take the final measurement
      // on the following frame, once those controls occupy their space.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      if (!anchor.isConnected) return;
      preservePosition();
    }
    const previous = rows().findLast(
      (row) => oldest !== undefined && row.id < oldest && linkTo(row.id)?.getClientRects().length,
    );
    linkTo(previous?.id)?.focus({ preventScroll: true });
  }
  async function later() {
    const newest = last()?.id;
    if (!(await stretch.showLater())) return;
    flush();
    reveal(linkTo(rows().find((row) => newest !== undefined && row.id > newest)?.id));
  }

  const earlierTime = () => rows().find((row) => row.at)?.at;
  const laterTime = () => rows().findLast((row) => row.at)?.at;
  const moments = createMemo(() => rows().filter((row) => row.runner && MOMENTS.has(row.kind)));
  const subAgents = createMemo(() => rows().filter((row) => row.ownerId !== undefined));
  const compactions = createMemo(() => rows().filter((row) => row.kind === "pi.compaction"));
  const errors = createMemo(() => rows().filter((row) => row.isError));
  return (
    <section class="tl" aria-labelledby="job-events">
      <div class="tl-head">
        <h2 id="job-events">Events</h2>
        <Show when={rows().length}>
          <span class="read">
            {stretch.hasEarlier() ? "The latest" : stretch.hasLater() ? "The first" : "All"}{" "}
            {formatCount(rows().length)} read
          </span>
          <div class="tl-choices">
            <fieldset class="seg">
              <legend class="vh">Show each Event</legend>
              <label>
                <input class="vh" type="radio" name="event-view" checked />
                In full
              </label>
              <label>
                <input class="vh view-line" type="radio" name="event-view" />
                One line each
              </label>
            </fieldset>
            <fieldset class="seg">
              <legend class="vh">Which Events</legend>
              <label>
                <input
                  class="vh"
                  type="radio"
                  name="event-kinds"
                  checked
                  ref={(el) => {
                    everything = el;
                  }}
                />
                Everything
              </label>
              <label>
                <input class="vh view-records" type="radio" name="event-kinds" />
                Runner’s records and errors
              </label>
            </fieldset>
          </div>
        </Show>
      </div>
      <Show when={stretch.failure()}>
        {(failure) => (
          <FailedReadNotice
            what="The Events"
            detail={hubFailureMessage(failure().error)}
            failedAt={failure().failedAt}
            readAt={failure().readAt}
          />
        )}
      </Show>
      <Show when={stretch.isLoading()}>
        <div aria-busy="true">
          <span class="sk" />
          <span class="sk is-short" />
          <span class="sk is-part" />
        </div>
        <p class="vh" role="status">
          Loading Events
        </p>
      </Show>
      <Show when={!rows().length && !stretch.isLoading() && !stretch.failure()}>
        <div class="empty">
          <h3>
            {props.job.status === "cancelled" && !props.job.startedAt
              ? "No Events: it ended before it started."
              : "No Events yet"}
          </h3>
          <Show when={props.job.status === "queued" && !props.job.startedAt}>
            <Link class="button" to="/runners">
              See which Runners are connected
            </Link>
          </Show>
        </div>
      </Show>
      <Show when={rows().length}>
        <nav class="jump-row" aria-label="Go to a moment of the job">
          <span>Go to</span>
          <button type="button" disabled={stretch.isFetchingPage()} onClick={() => void jump(true)}>
            Start
          </button>
          <For each={moments()} keyed={(row) => row.id}>
            {(row) => (
              <a href={`#event-${row().id}`}>
                {MOMENTS.get(row().kind)}{" "}
                <Show when={row().at}>
                  {(at) => <Instant value={at()} format={TIME_SECONDS} />}
                </Show>
              </a>
            )}
          </For>
          <JumpGroup name="sub-agent" multiple="sub-agents" rows={subAgents()} content />
          <JumpGroup name="compaction" multiple="compactions" rows={compactions()} content />
          <JumpGroup name="error" multiple="errors" rows={errors()} />
          <button
            type="button"
            disabled={stretch.isFetchingPage()}
            onClick={() => void jump(false)}
          >
            Latest
          </button>
        </nav>
      </Show>
      <Show when={stretch.hasEarlier()}>
        <div class="stretch-end">
          <p>
            Events before{" "}
            <Show when={earlierTime()} fallback="this stretch">
              {(at) => <Instant value={at()} format={TIME_SECONDS} />}
            </Show>{" "}
            are not shown.
          </p>
          <button type="button" disabled={stretch.isFetchingPage()} onClick={() => void earlier()}>
            Show 100 earlier Events
          </button>
        </div>
      </Show>
      <ol
        class="timeline"
        ref={(el) => {
          timeline = el;
        }}
      >
        <For each={rows()} keyed={(row) => row.id}>
          {(row) => (
            <>
              <Show when={props.groups.dayLines.has(row().id) && row().at}>
                {(at) => (
                  <li class="day-line">
                    <Instant value={at()} format={DAY_YEAR} />
                  </li>
                )}
              </Show>
              <Show when={props.groups.headings.get(row().id)}>
                {(run) => (
                  <RunHeading
                    run={run()}
                    running={running() && props.groups.currentRun === run()}
                  />
                )}
              </Show>
              <JobEventRow
                row={row()}
                userLabel={props.groups.userLabels.get(row().id)}
                subAgent={props.groups.subAgents.has(row().conversationId ?? 0)}
                currentOutput={
                  props.job.status === "succeeded" &&
                  stretch.isAtLatest() &&
                  row().kind === JOB_SUCCEEDED &&
                  props.job.output !== undefined &&
                  !rows().some(
                    (other) =>
                      other.id > row().id &&
                      (other.kind === JOB_RESUMED || other.kind === JOB_SUCCEEDED),
                  )
                }
              />
            </>
          )}
        </For>
        <Show when={running()}>
          <li class="ev is-live" id="latest" tabindex="-1">
            <JobActivity job={props.job} atEnd />
          </li>
        </Show>
      </ol>
      <Show when={stretch.hasLater()}>
        <div class="stretch-end">
          <p>
            Events after{" "}
            <Show when={laterTime()} fallback="this stretch">
              {(at) => <Instant value={at()} format={TIME_SECONDS} />}
            </Show>{" "}
            are not shown.
          </p>
          <button type="button" disabled={stretch.isFetchingPage()} onClick={() => void later()}>
            Show 100 later Events
          </button>
        </div>
      </Show>
      <div role="status" aria-atomic="true" class="new-events">
        <Show when={unread()[0]}>
          {(firstNew) => (
            <>
              <span>
                <strong>
                  {formatCount(unread().length)} new {plural(unread().length, "Event", "Events")}
                </strong>{" "}
                below
                <Show when={newestUnreadTime()}>
                  {(at) => (
                    <>
                      , the latest <Instant value={at()} format={TIME_SECONDS} />
                    </>
                  )}
                </Show>
                .
              </span>
              <button
                type="button"
                onClick={() => {
                  reveal(linkTo(firstNew().id));
                  setSeen(arrivals().at(-1)?.id ?? 0);
                }}
              >
                Go to them
              </button>
            </>
          )}
        </Show>
      </div>
    </section>
  );
}
