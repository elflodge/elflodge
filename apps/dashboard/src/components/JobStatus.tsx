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
  return (
    <>
      <Show when={props.job.statusUnknown}>
        {(unknown) => (
          <span
            class="beside is-unknown"
            title={`${statusUnknownWords(unknown().reason, "short")}, since ${FULL.format(unknown().since)}`}
          >
            <span class="mark mark-unknown" aria-hidden="true" />
            <span>
              Status unknown
              <Show
                when={props.detailed}
                fallback={
                  <span class="condition-detail">
                    {statusUnknownWords(unknown().reason, "short")}
                  </span>
                }
              >
                {" "}
                since <Instant value={unknown().since} format={TIME_SECONDS} />:{" "}
                {statusUnknownWords(unknown().reason, "detail")}
              </Show>
            </span>
          </span>
        )}
      </Show>
      <Show when={props.job.pendingControl}>
        {(control) => (
          <span class="beside" title={`Asked ${FULL.format(control().requestedAt)}`}>
            <span class="mark mark-pending" aria-hidden="true" />
            <span>
              {CONTROL_WORDS[control().type]}
              <Show
                when={props.detailed}
                fallback={
                  <span class="condition-detail">
                    <Instant value={control().requestedAt} />
                  </span>
                }
              >
                {" "}
                <Instant value={control().requestedAt} format={TIME_SECONDS} />, waiting for its
                Runner{control().type === "delete" ? " to delete its files" : ""}
              </Show>
            </span>
          </span>
        )}
      </Show>
      <Show
        when={props.job.blockedBy === undefined ? undefined : blockedWords(props.job.blockedBy)}
      >
        {(blockedBy) => (
          <span class="beside">
            <span class="mark mark-blocked" aria-hidden="true" />
            {blockedBy()}
          </span>
        )}
      </Show>
      {/* The Show's value is the reason, a string, not the failure. When the job turns from failed
          to queued, Solid 2.0.0 lets the child read the value as undefined before the Show drops
          it; a child reading a member of it throws, then throws "Stale read from <Show>" without
          end, and the page stops updating. */}
      <Show when={props.job.status === "failed" ? props.job.failure.reason : undefined}>
        {(reason) => (
          <span class="beside">
            <span>
              <FailureReason reason={reason()} />
              <Show when={props.detailed && FAILURE_WORDS.get(reason())}>
                {(words) => <>: {words()}</>}
              </Show>
            </span>
          </span>
        )}
      </Show>
    </>
  );
}
