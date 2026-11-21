import type {
  BlockedBy,
  OpenBlockedBy,
  Failure,
  Job,
  JobStatus as Status,
  ListedJob,
  OpenFailure,
  OpenStatusUnknownReason,
  StatusUnknownReason,
} from "contract";
import { Show } from "solid-js";

import { FULL, TIME_SECONDS } from "../format.ts";
import { Instant } from "./Instant.tsx";

/** Each status's word, as a job's status and a filter by it say it. */
export const STATUS_WORDS: Record<Status, string> = {
  queued: "Queued",
  running: "Running",
  paused: "Paused",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

const BLOCKED_WORDS = new Map(
  Object.entries({
    batchPausedByCaller: "Blocked: Batch paused",
    batchPausedByBreaker: "Blocked: failure breaker",
    batchCanary: "Waiting for Canary",
  } satisfies Record<BlockedBy, string>),
);

const UNKNOWN_WORDS = new Map(
  Object.entries({
    runnerDisconnected: { short: "Runner not connected", detail: "its Runner is not connected" },
    notReported: { short: "not reported", detail: "its Runner has not reported it" },
  } satisfies Record<StatusUnknownReason, { short: string; detail: string }>),
);

function statusUnknownWords(reason: OpenStatusUnknownReason, form: "short" | "detail") {
  return UNKNOWN_WORDS.get(reason)?.[form] ?? unknownWord(reason);
}

function blockedWords(reason: OpenBlockedBy) {
  return BLOCKED_WORDS.get(reason) ?? `Blocked: ${unknownWord(reason)}`;
}

const CONTROL_WORDS: Record<NonNullable<Job["pendingControl"]>["type"], string> = {
  pause: "Pause asked",
  cancel: "Cancel asked",
  delete: "Delete asked",
};

/**
 * A job's status, as a mark and a word, and beside it each condition the job reports with it: a
 * status the hub cannot confirm, a control its Runner has not yet acted on, what blocks it, and why
 * it failed. While the status is unknown, the word is the last status the hub recorded.
 */
export function JobStatus(props: { status: Status; lastRecorded: boolean }) {
  return (
    <span class={["status-word", `s-${props.status}`, { "is-unknown": props.lastRecorded }]}>
      <span class={["mark", `mark-${props.status}`]} aria-hidden="true" />
      {STATUS_WORDS[props.status]}
      <Show when={props.lastRecorded}>
        <span class="vh"> (last recorded)</span>
      </Show>
    </span>
  );
}

export const FAILURE_WORDS = new Map(
  Object.entries({
    modelFailed: "Generating the next step failed.",
    noOutput: "its agent ended without an accepted Output",
    runTimedOut: "a run went past its run timeout",
    modelBudgetExceeded: "its model calls’ cost reached its model budget",
    runFaulted: "its run broke on its Runner",
    runnerRemoved: "its Runner was removed before it ended",
    journalLost: "its Runner’s journal of it was lost",
  } satisfies Record<Failure["reason"], string>),
);

const UNKNOWN_TO_DASHBOARD = "(unknown to this dashboard version)";

export function unknownWord(value: string) {
  return `${JSON.stringify(value)} ${UNKNOWN_TO_DASHBOARD}`;
}

export function FailureReason(props: { reason: OpenFailure["reason"] }) {
  const known = () => FAILURE_WORDS.has(props.reason);
  return (
    <>
      <code class="failure-reason">{known() ? props.reason : JSON.stringify(props.reason)}</code>
      <Show when={!known()}>
        {" "}
        <span>{UNKNOWN_TO_DASHBOARD}</span>
      </Show>
    </>
  );
}

export function BesideStatus(props: { job: ListedJob | Job; detailed?: boolean }) {
  // The two conditions are read directly, not keyed: on the job page each poll brings new Dates in
  // them, which would rebuild a keyed child and drop the tooltip of its title.
  const unknown = () => props.job.statusUnknown;
  const unknownWords = (form: "short" | "detail") => {
    const value = unknown();
    return value && statusUnknownWords(value.reason, form);
  };
  const unknownTitle = () => {
    const value = unknown();
    return (
      value && `${statusUnknownWords(value.reason, "short")}, since ${FULL.format(value.since)}`
    );
  };
  const control = () => props.job.pendingControl;
  const controlWords = () => {
    const value = control();
    return value && CONTROL_WORDS[value.type];
  };
  const asked = () => {
    const value = control();
    return value && `Asked ${FULL.format(value.requestedAt)}`;
  };
  return (
    <>
      <Show when={unknown()}>
        <span class="beside is-unknown" title={unknownTitle()}>
          <span class="mark mark-unknown" aria-hidden="true" />
          <span>
            Status unknown
            <Show
              when={props.detailed}
              fallback={<span class="condition-detail">{unknownWords("short")}</span>}
            >
              {" "}
              since <Instant value={unknown()?.since} format={TIME_SECONDS} />:{" "}
              {unknownWords("detail")}
            </Show>
          </span>
        </span>
      </Show>
      <Show when={control()}>
        <span class="beside" title={asked()}>
          <span class="mark mark-pending" aria-hidden="true" />
          <span>
            {controlWords()}
            <Show
              when={props.detailed}
              fallback={
                <span class="condition-detail">
                  <Instant value={control()?.requestedAt} />
                </span>
              }
            >
              {" "}
              <Instant value={control()?.requestedAt} format={TIME_SECONDS} />, waiting for its
              Runner{control()?.type === "delete" ? " to delete its files" : ""}
            </Show>
          </span>
        </span>
      </Show>
      <Show
        when={props.job.blockedBy === undefined ? undefined : blockedWords(props.job.blockedBy)}
        keyed
      >
        {(blockedBy) => (
          <span class="beside">
            <span class="mark mark-blocked" aria-hidden="true" />
            {blockedBy}
          </span>
        )}
      </Show>
      {/* The Show tests the failure, which is truthy even when its reason is an empty string, and is
          keyed, so the child gets the failure itself rather than an accessor. When the job turns
          from failed to queued, Solid 2.0.0's accessor can return undefined before the Show drops
          its child; reading the reason from that threw, and in our runs the page then kept
          re-reading it and stopped updating. */}
      <Show when={props.job.status === "failed" ? props.job.failure : undefined} keyed>
        {(failure) => (
          <span class="beside">
            <span>
              <FailureReason reason={failure.reason} />
              <Show when={props.detailed && FAILURE_WORDS.get(failure.reason)}>
                {(words) => <>: {words()}</>}
              </Show>
            </span>
          </span>
        )}
      </Show>
    </>
  );
}
