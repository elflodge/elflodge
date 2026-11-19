import { Link } from "@tanstack/solid-router";
import { JOB_PAUSED, JOB_RECOVERED, JOB_RESUMED, JOB_SUCCEEDED, type Job } from "contract";
import { For, Show, createEffect, createMemo, createSignal, flush } from "solid-js";

import { hubFailureMessage } from "../api-client.ts";
import { DAY_YEAR, TIME_SECONDS, formatCount, plural } from "../format.ts";
import type { ReadJobEvent } from "../job-event-record.ts";
import type { JobEventStretch } from "../job-event-stretch.ts";
import type { JobEventGroups } from "../job-runs.ts";
import { FailedReadNotice } from "./FailedReadNotice.tsx";
import { Instant } from "./Instant.tsx";
import { JobActivity } from "./JobActivity.tsx";
import { JobEventRow } from "./JobEventRow.tsx";
import { RunHeading } from "./JobRun.tsx";

function linkTo(id?: number) {
  return id === undefined ? null : document.getElementById(`event-${id}`);
}

function shownNumber(events: readonly { id: number }[], fromEnd: boolean) {
  const shown = (event: { id: number }) => linkTo(event.id)?.getClientRects().length;
  return linkTo((fromEnd ? events.findLast(shown) : events.find(shown))?.id);
}

function reveal(target: HTMLElement | null) {
  target?.scrollIntoView({ block: "center" });
  target?.focus({ preventScroll: true });
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
              <a
                class="stands-alone"
                href={`#event-${row().id}`}
                aria-label={`${props.name}, Event ${row().id}`}
              >
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
  let heading: HTMLHeadingElement | undefined;
  const arrivals = stretch.liveEvents;
  const [unread, setUnread] = createSignal<readonly { id: number }[]>([]);
  let seenThrough = 0;
  const newestUnreadTime = () => {
    const id = unread().at(-1)?.id;
    return rows().findLast((row) => row.id === id)?.at;
  };

  // Each observation belongs to the arrivals already laid out. A burst can move the live row
  // completely off a phone screen, even while it was visible throughout the preceding poll.
  createEffect(
    () => ({
      end: running() ? "latest" : last()?.id,
      newest: arrivals().at(-1)?.id ?? 0,
    }),
    ({ newest }) => {
      if (!newest) {
        seenThrough = 0;
        setUnread([]);
      }
      const end = timeline?.lastElementChild;
      if (!end) return undefined;
      const observer = new IntersectionObserver(([entry]) => {
        if (entry.isIntersecting) seenThrough = newest;
        setUnread(arrivals().filter((row) => row.id > seenThrough && row.id <= newest));
      });
      observer.observe(end);
      return () => observer.disconnect();
    },
  );

  function goToEnd() {
    const target = document.getElementById("latest") ?? shownNumber(rows(), true);
    if (target) reveal(target);
    else {
      timeline?.scrollIntoView({ block: "end" });
      timeline?.focus({ preventScroll: true });
    }
  }
  async function jump(toStart: boolean) {
    if (toStart && stretch.hasEarlier() && !(await stretch.start())) return;
    if (!toStart && stretch.hasLater() && !(await stretch.latest())) return;
    flush();
    if (toStart) reveal(shownNumber(rows(), false) ?? heading ?? null);
    else goToEnd();
  }

  async function extend(earlier: boolean, button: HTMLButtonElement) {
    const edge = earlier ? first()?.id : last()?.id;
    if (edge === undefined) return;
    const anchor =
      earlier && !CSS.supports("overflow-anchor", "auto") ? shownNumber(rows(), false) : null;
    const documentTop = () => (anchor?.getBoundingClientRect().top ?? 0) + window.scrollY;
    let previousTop = documentTop();
    const added = await (earlier ? stretch.showEarlier() : stretch.showLater());
    flush();
    if (earlier && added) {
      // Scroll anchoring first shipped in Safari 27; the dashboard also supports Safari 17.5.
      // https://github.com/mdn/browser-compat-data/blob/main/css/properties/overflow-anchor.json
      // Correct the change in document coordinates so scrolling during the read is preserved.
      const compensate = () => {
        if (!anchor?.isConnected) return;
        const nextTop = documentTop();
        window.scrollBy(0, nextTop - previousTop);
        previousTop = nextTop;
      };
      compensate();
      // Focusing a new Event can change the browser's scroll anchor. Keep the old anchor
      // until ResizeObserver has measured the new previews and their buttons occupy space.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      if (!timeline?.isConnected) return;
      compensate();
    }
    const addedNumber =
      added &&
      shownNumber(
        rows().filter((row) => (earlier ? row.id < edge : row.id > edge)),
        earlier,
      );
    if (addedNumber && !earlier) {
      reveal(addedNumber);
    } else {
      const fallback = button.isConnected ? button : (shownNumber(rows(), !earlier) ?? heading);
      (addedNumber || fallback)?.focus({ preventScroll: true });
    }
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
        <h2
          id="job-events"
          tabindex="-1"
          ref={(el) => {
            heading = el;
          }}
        >
          Events
        </h2>
        <Show when={rows().length}>
          <span class="read" role="status">
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
                <input class="vh" type="radio" name="event-kinds" checked />
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
              <a class="stands-alone" href={`#event-${row().id}`}>
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
            <Show when={earlierTime()} fallback="Earlier Events are not shown.">
              {(at) => (
                <>
                  Events before <Instant value={at()} format={TIME_SECONDS} /> are not shown.
                </>
              )}
            </Show>
          </p>
          <button
            type="button"
            disabled={stretch.isFetchingPage()}
            onClick={(e) => void extend(true, e.currentTarget)}
          >
            Show earlier Events
          </button>
        </div>
      </Show>
      <ol
        class="timeline"
        aria-labelledby="job-events"
        tabindex="-1"
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
                    shortRunId={props.groups.shortRunIds.get(row().runId ?? "")}
                    running={running() && props.groups.currentRun === run()}
                  />
                )}
              </Show>
              <JobEventRow
                row={row()}
                shortRunId={props.groups.shortRunIds.get(row().runId ?? "")}
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
            <Show when={laterTime()} fallback="Later Events are not shown.">
              {(at) => (
                <>
                  Events after <Instant value={at()} format={TIME_SECONDS} /> are not shown.
                </>
              )}
            </Show>
          </p>
          <button
            type="button"
            disabled={stretch.isFetchingPage()}
            onClick={(e) => void extend(false, e.currentTarget)}
          >
            Show later Events
          </button>
        </div>
      </Show>
      <div role="status" aria-atomic="true" class="new-events">
        <Show when={unread().length}>
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
                const firstNew = shownNumber(unread(), false);
                if (firstNew) reveal(firstNew);
                else goToEnd();
                seenThrough = unread().at(-1)?.id ?? seenThrough;
                setUnread([]);
              }}
            >
              Go to them
            </button>
          </>
        </Show>
      </div>
    </section>
  );
}
