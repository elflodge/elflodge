import { Link } from "@tanstack/solid-router";
import { JOB_PAUSED, JOB_RECOVERED, JOB_RESUMED, JOB_SUCCEEDED, type Job } from "contract";
import { For, Show, createEffect, createMemo, createSignal, flush } from "solid-js";

import { failureDetailSuffix, hubFailureMessage } from "../api-client.ts";
import { DAY_YEAR, TIME_SECONDS, formatCount, plural } from "../format.ts";
import type { ReadJobEvent } from "../job-event-record.ts";
import type { JobEvents, PagingDirection } from "../job-events.ts";
import type { JobEventGroups } from "../job-runs.ts";
import { FailedReadNotice } from "./FailedReadNotice.tsx";
import { Instant } from "./Instant.tsx";
import { JobActivity } from "./JobActivity.tsx";
import { JobEventRow } from "./JobEventRow.tsx";
import { RunHeading } from "./JobRun.tsx";
import { Notice } from "./Notice.tsx";

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
  at?: Date;
  read: (direction: PagingDirection) => Promise<HTMLElement | null>;
  jump: () => Promise<void>;
  timeline: () => HTMLOListElement | undefined;
}) {
  const earlier = () => props.direction === "earlier";
  const hasPage = () => props.events.hasPage(props.direction);
  const error = () => props.events.pageError(props.direction);
  const retryJump = () => !hasPage() && !!error();
  const usedUp = () => props.events.usedUp(props.direction) && !retryJump();
  const edgeTime = createMemo<Date | undefined>((previous) => (usedUp() ? previous : props.at));
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
              <p>
                <Show
                  when={edgeTime()}
                  fallback={
                    earlier() ? "Earlier Events are not shown." : "Later Events are not shown."
                  }
                >
                  {(at) => (
                    <>
                      Events {earlier() ? "before" : "after"}{" "}
                      <Instant value={at()} format={TIME_SECONDS} /> are not shown.
                    </>
                  )}
                </Show>
              </p>
            }
          >
            {(failure) => (
              <Notice role="alert">
                The {props.direction} Events could not be read
                {failureDetailSuffix(hubFailureMessage(failure()))}
              </Notice>
            )}
          </Show>
          <button
            type="button"
            disabled={props.events.isReadingPage()}
            onClick={(e) => void (retryJump() ? props.jump() : read(e.currentTarget))}
          >
            {retryJump() ? (earlier() ? "Start" : "Latest") : `Show ${props.direction} Events`}
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
    const target = document.getElementById("latest") ?? shownNumber(rows(), true);
    if (target) reveal(target);
    else {
      timeline?.scrollIntoView({ block: "end" });
      timeline?.focus({ preventScroll: true });
    }
  }
  async function jump(toStart: boolean) {
    if (
      toStart &&
      (events.hasPage("earlier") || events.pageError("earlier")) &&
      !(await events.readFromStart())
    )
      return;
    if (
      !toStart &&
      (!events.isAtLatest() || events.pageError("later")) &&
      !(await events.readLatest())
    )
      return;
    flush();
    setAddition(undefined);
    if (toStart) reveal(shownNumber(rows(), false) ?? heading ?? null);
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
        jump={() => jump(true)}
        events={events}
        at={earlierTime()}
        read={extend}
        timeline={() => timeline}
      />
      <Show when={rows().length}>
        <nav class="jump-row" aria-label="Go to a moment of the job">
          <span>Go to</span>
          <button type="button" disabled={events.isReadingPage()} onClick={() => void jump(true)}>
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
          <button type="button" disabled={events.isReadingPage()} onClick={() => void jump(false)}>
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
      <PageEdge
        direction="later"
        jump={() => jump(false)}
        events={events}
        at={laterTime()}
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
