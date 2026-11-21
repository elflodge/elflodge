import { Link } from "@tanstack/solid-router";
import { JOB_PAUSED, JOB_RECOVERED, JOB_RESUMED, JOB_SUCCEEDED, type Job } from "contract";
import { For, Show, createEffect, createMemo, createSignal, flush } from "solid-js";

import { failureDetailSuffix, hubFailureDetail } from "../api-client.ts";
import { focusIfLost } from "../form.ts";
import { DAY_YEAR, TIME_SECONDS, formatCount, plural } from "../format.ts";
import type { ReadJobEvent } from "../job-event-record.ts";
import type { JobEvents, PagingDirection } from "../job-events.ts";
import type { JobEventGroups } from "../job-runs.ts";
import { FailedReadNotice } from "./FailedReadNotice.tsx";
import { Instant } from "./Instant.tsx";
import { JobEventRow } from "./JobEventRow.tsx";
import { RunHeading } from "./JobRun.tsx";
import { Notice } from "./Notice.tsx";

function linkTo(id?: number) {
  return id === undefined ? null : document.getElementById(`event-${id}`);
}

function firstShownNumber(events: readonly { id: number }[]) {
  return linkTo(events.find((event) => linkTo(event.id)?.getClientRects().length)?.id);
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

function firstAddedItem(previous: number | undefined, lastAdded: number | undefined) {
  const end = linkTo(lastAdded)?.closest("li");
  if (!end) return null;
  let item = linkTo(previous)?.closest("li")?.nextElementSibling;
  while (item instanceof HTMLElement) {
    if (item.getClientRects().length)
      return item.querySelector<HTMLAnchorElement>(".ev-id") ?? item;
    if (item === end) break;
    item = item.nextElementSibling;
  }
  return null;
}

function PageEdge(props: {
  direction: PagingDirection;
  events: JobEvents;
  read: (direction: PagingDirection) => Promise<HTMLElement | null>;
  jump: (button: HTMLButtonElement) => Promise<void>;
  timeline: () => HTMLOListElement | undefined;
}) {
  const earlier = () => props.direction === "earlier";
  const hasPage = () => props.events.hasPage(props.direction);
  const error = () => props.events.pageError(props.direction);
  const retryJump = () => error()?.jump;
  const jumpLabel = () => (earlier() ? "Start" : "Latest");
  const usedUp = () => props.events.usedUp(props.direction) && !retryJump();
  let box: HTMLDivElement | undefined;
  async function read(button: HTMLButtonElement) {
    const hadFocus = document.activeElement === button;
    const firstAdded = await props.read(props.direction);
    const active = document.activeElement;
    if (
      hadFocus &&
      box?.isConnected &&
      (active === button || !active || active === document.body)
    ) {
      const target = firstAdded ?? (usedUp() ? (earlier() ? box : props.timeline()) : button);
      target?.focus({ preventScroll: true });
    }
  }
  return (
    <Show when={hasPage() || usedUp() || error()}>
      <div
        class="events-edge-note"
        tabindex={earlier() && usedUp() ? "-1" : undefined}
        aria-hidden={!earlier() && usedUp() ? "true" : undefined}
        ref={(el) => {
          box = el;
        }}
      >
        <div aria-hidden={usedUp() ? "true" : undefined}>
          <Show
            when={error()}
            fallback={
              <p>{earlier() ? "Earlier Events are not shown." : "Later Events are not shown."}</p>
            }
          >
            {/* Read directly: the alert is a live region (AGENTS.md). */}
            <Notice role="alert">
              {error()?.jump
                ? `${jumpLabel()} failed`
                : `The ${props.direction} Events could not be read`}
              {failureDetailSuffix(hubFailureDetail(error()?.error))}
            </Notice>
          </Show>
          <button
            type="button"
            id={`events-${props.direction}-button`}
            disabled={props.events.isReadingPage()}
            onClick={(e) =>
              void (retryJump() ? props.jump(e.currentTarget) : read(e.currentTarget))
            }
          >
            {retryJump() ? jumpLabel() : `Show ${props.direction} Events`}
          </button>
        </div>
        <Show when={earlier() && usedUp()}>
          <p>There are no earlier Events.</p>
        </Show>
      </div>
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
  const last = () => rows().at(-1);
  const running = () => props.running && events.isAtLatest();
  let timeline: HTMLOListElement | undefined;
  let heading: HTMLHeadingElement | undefined;
  const [addition, setAddition] = createSignal<{ newest?: number; sentence: string }>();
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
    reveal(document.getElementById("latest") ?? endMarker ?? null);
  }
  async function jump(toStart: boolean, button: HTMLButtonElement) {
    const focused = document.activeElement;
    const side = toStart ? "earlier" : "later";
    const needsRead =
      (toStart ? events.hasPage("earlier") : !events.isAtLatest()) || events.pageError(side)?.jump;
    const reached =
      !needsRead || (toStart ? await events.readFromStart() : await events.readLatest());
    flush();
    if (!timeline?.isConnected) return;
    if (!reached) {
      focusIfLost(button.isConnected ? button : document.getElementById(`events-${side}-button`));
      return;
    }
    setAddition(undefined);
    const active = document.activeElement;
    if (
      active !== focused &&
      active !== document.body &&
      active?.checkVisibility({ visibilityProperty: true })
    )
      return;
    if (toStart) reveal(firstShownNumber(rows()) ?? heading ?? null);
    else goToEnd();
  }

  async function extend(direction: PagingDirection) {
    if (events.isReadingPage()) return null;
    const previous = last()?.id;
    const page = await events.readPage(direction);
    flush();
    if (!page || !timeline?.isConnected) return null;
    const count = page.events.length;
    setAddition({
      newest: last()?.id,
      sentence: `${formatCount(count)} ${direction} ${plural(count, "Event", "Events")} added.`,
    });
    return direction === "later" ? firstAddedItem(previous, page.events.at(-1)?.id) : null;
  }

  const readCount = () => {
    const count = formatCount(rows().length);
    const range = events.isAtLatest()
      ? events.hasPage("earlier")
        ? "The latest "
        : "All "
      : events.hasPage("earlier")
        ? ""
        : "The first ";
    const total = `${range}${count} read`;
    const added = addition();
    return added && added.newest === last()?.id ? `${added.sentence} ${total}.` : total;
  };
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
      {/* Read directly: the child holds an alert and the Latest button (AGENTS.md). */}
      <Show when={events.failure()}>
        <FailedReadNotice
          what="The Events"
          detail={hubFailureDetail(events.failure()?.error)}
          failedAt={events.failure()?.failedAt}
          readAt={events.failure()?.readAt}
        />
        <Show when={!rows().length && events.failure()?.follower}>
          <button
            type="button"
            disabled={events.isReadingPage()}
            onClick={(e) => void jump(false, e.currentTarget)}
          >
            Latest
          </button>
        </Show>
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
      <Show
        when={
          !rows().length &&
          !events.isLoading() &&
          !events.failure() &&
          !events.pageError("earlier") &&
          !events.pageError("later")
        }
      >
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
      <PageEdge
        direction="earlier"
        jump={(button) => jump(true, button)}
        events={events}
        read={extend}
        timeline={() => timeline}
      />
      <Show when={rows().length}>
        <nav class="jump-row" aria-label="Go to a moment of the job">
          <span>Go to</span>
          <button
            type="button"
            disabled={events.isReadingPage()}
            onClick={(e) => void jump(true, e.currentTarget)}
          >
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
          <button
            type="button"
            disabled={events.isReadingPage()}
            onClick={(e) => void jump(false, e.currentTarget)}
          >
            Latest
          </button>
        </nav>
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
                  <li class="day-line" tabindex="-1">
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
            <span class="mark mark-running" aria-hidden="true" /> Still running.{" "}
            <Link to="." hash="job-activity">
              Latest activity
            </Link>{" "}
            is at the top of this page.
          </li>
        </Show>
      </ol>
      <div
        class="timeline-end"
        role="group"
        aria-label="End of Events"
        tabindex="-1"
        ref={(el) => {
          endMarker = el;
        }}
      />
      <PageEdge
        direction="later"
        jump={(button) => jump(false, button)}
        events={events}
        read={extend}
        timeline={() => timeline}
      />
      <div role="status" aria-atomic="true" class="new-events">
        <Show when={unread().length}>
          <>
            <span>
              <strong>
                {formatCount(unread().length)} new {plural(unread().length, "Event", "Events")}
              </strong>{" "}
              below
              {/* Read directly: this is in a live region (AGENTS.md). */}
              <Show when={newestUnreadTime()}>
                , Event {unread().at(-1)?.id} at{" "}
                <Instant value={newestUnreadTime()} format={TIME_SECONDS} />
              </Show>
              .
            </span>
            <button
              type="button"
              onClick={() => {
                const firstNew = firstShownNumber(unread());
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
