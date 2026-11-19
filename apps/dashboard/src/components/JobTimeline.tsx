import { Link } from "@tanstack/solid-router";
import { JOB_PAUSED, JOB_RECOVERED, JOB_RESUMED, JOB_SUCCEEDED, type Job } from "contract";
import { For, Show, createEffect, createMemo, createSignal, flush } from "solid-js";

import { hubFailureMessage } from "../api-client.ts";
import { DAY_YEAR, TIME_SECONDS, formatCount, plural } from "../format.ts";
import type { ReadJobEvent } from "../job-event-record.ts";
import type { JobEvents } from "../job-events.ts";
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

const MOMENTS: ReadonlySet<string> = new Set([JOB_PAUSED, JOB_RESUMED, JOB_RECOVERED]);

export function JobTimeline(props: {
  job: Job;
  running: boolean;
  events: JobEvents;
  groups: JobEventGroups;
}) {
  const events = props.events;
  const rows = () => props.groups.events;
  const first = () => rows().at(0);
  const last = () => rows().at(-1);
  const running = () => props.running && events.isAtLatest();
  let timeline: HTMLOListElement | undefined;
  let heading: HTMLHeadingElement | undefined;
  let endMarker: HTMLDivElement | undefined;
  const arrivals = events.liveEvents;
  const [unread, setUnread] = createSignal<readonly { id: number }[]>([]);
  let seenThrough = 0;
  const newestUnreadTime = () => {
    const id = unread().at(-1)?.id;
    return rows().findLast((row) => row.id === id)?.at;
  };

  // Each observation belongs to the arrivals already laid out. A burst can move the live row
  // completely off a phone screen, even while it was visible throughout the preceding poll.
  createEffect(
    () => arrivals().at(-1)?.id ?? 0,
    (newest) => {
      if (!newest) {
        seenThrough = 0;
        setUnread([]);
      }
      if (!endMarker || !newest) return undefined;
      const observer = new IntersectionObserver(([entry]) => {
        if (entry.isIntersecting) seenThrough = newest;
        setUnread(arrivals().filter((row) => row.id > seenThrough && row.id <= newest));
      });
      observer.observe(endMarker);
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
    if (toStart && events.hasEarlier() && !(await events.readFromStart())) return;
    if (!toStart && !events.isAtLatest() && !(await events.readLatest())) return;
    flush();
    if (toStart) reveal(shownNumber(rows(), false) ?? heading ?? null);
    else goToEnd();
  }

  async function extend(earlier: boolean, button: HTMLButtonElement) {
    const edge = earlier ? first()?.id : last()?.id;
    const list = timeline;
    if (edge === undefined || !list || list.dataset.paging !== undefined) return;
    const focused = document.activeElement;
    const anchor = earlier
      ? (shownNumber(rows(), false) ?? document.getElementById("latest"))
      : null;
    const top = anchor?.getBoundingClientRect().top;
    let expectedScrollY = window.scrollY;
    // Suspend native anchoring to distinguish a reader scroll from an anchoring adjustment.
    // The browser can still clamp the offset when the last paging control disappears.
    // Restore anchoring on a reader scroll or before the correction’s queued event is delivered.
    // Safari 17.5 predates native anchoring (Safari 27) and uses the same measured correction.
    // https://github.com/mdn/browser-compat-data/blob/main/css/properties/overflow-anchor.json
    list.dataset.paging = "keep-position";
    const observeScroll = () => {
      const y = window.scrollY;
      if (y === expectedScrollY || list.dataset.paging === "reader-scrolled") return;
      const root = document.documentElement;
      const bottom = root.scrollHeight - root.clientHeight;
      if (expectedScrollY > bottom && Math.abs(y - bottom) < 1) expectedScrollY = y;
      else list.dataset.paging = "reader-scrolled";
    };
    window.addEventListener("scroll", observeScroll);
    let added: boolean;
    try {
      added = await (earlier ? events.readEarlier() : events.readLater());
      flush();
      if (anchor && added) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      }
      observeScroll();
      if (
        !list.isConnected ||
        list.dataset.paging === "reader-scrolled" ||
        (document.activeElement !== focused && document.activeElement !== document.body)
      )
        return;
      if (added && anchor?.isConnected && top !== undefined)
        window.scrollBy(0, anchor.getBoundingClientRect().top - top);
    } finally {
      window.removeEventListener("scroll", observeScroll);
      delete list.dataset.paging;
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

  const readCount = () => {
    const count = formatCount(rows().length);
    if (events.isAtLatest()) return `${events.hasEarlier() ? "The latest" : "All"} ${count} read`;
    return events.hasEarlier() ? `${count} read` : `The first ${count} read`;
  };
  const earlierTime = () => rows().find((row) => row.at)?.at;
  const laterTime = () => rows().findLast((row) => row.at)?.at;
  const moments = createMemo(() => rows().filter((row) => row.lifecycle && MOMENTS.has(row.kind)));
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
            {readCount()}
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
      <Show when={events.failure()}>
        {(failure) => (
          <FailedReadNotice
            what="The Events"
            detail={hubFailureMessage(failure().error)}
            failedAt={failure().failedAt}
            readAt={failure().readAt}
          />
        )}
      </Show>
      <Show when={events.isLoading()}>
        <div aria-busy="true">
          <span class="sk" />
          <span class="sk is-short" />
          <span class="sk is-part" />
        </div>
        <p class="vh" role="status">
          Loading Events
        </p>
      </Show>
      <Show when={!rows().length && !events.isLoading() && !events.failure()}>
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
          <button type="button" disabled={events.isFetchingPage()} onClick={() => void jump(true)}>
            Start
          </button>
          <For each={moments()} keyed={(row) => row.id}>
            {(row) => (
              <a class="stands-alone" href={`#event-${row().id}`}>
                {row().lifecycle?.label}{" "}
                <Show when={row().at}>
                  {(at) => <Instant value={at()} format={TIME_SECONDS} />}
                </Show>
              </a>
            )}
          </For>
          <JumpGroup name="sub-agent" multiple="sub-agents" rows={subAgents()} content />
          <JumpGroup name="compaction" multiple="compactions" rows={compactions()} content />
          <JumpGroup name="error" multiple="errors" rows={errors()} />
          <button type="button" disabled={events.isFetchingPage()} onClick={() => void jump(false)}>
            Latest
          </button>
        </nav>
      </Show>
      <Show when={events.hasEarlier()}>
        <div class="events-edge-note">
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
            disabled={events.isFetchingPage()}
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
                  events.isAtLatest() &&
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
      <div
        class="timeline-end"
        aria-hidden="true"
        ref={(el) => {
          endMarker = el;
        }}
      />
      <Show when={events.hasLater()}>
        <div class="events-edge-note">
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
            disabled={events.isFetchingPage()}
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
