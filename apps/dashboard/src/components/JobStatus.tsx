import type {
  BlockedBy,
  Failure,
  Job,
  JobStatus as Status,
  ListedJob,
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

const BLOCKED_WORDS: Record<BlockedBy, string> = {
  batchPausedByCaller: "Blocked: Batch paused",
  batchPausedByBreaker: "Blocked: failure breaker",
  batchCanary: "Waiting for Canary",
};

const UNKNOWN_WORDS: Record<StatusUnknownReason, string> = {
  runnerDisconnected: "Runner not connected",
  notReported: "not reported",
};

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
export function JobStatus(props: { job: ListedJob | Job }) {
  return (
    <span
      class={["status-word", `s-${props.job.status}`, { "is-unknown": !!props.job.statusUnknown }]}
    >
      <span class={["mark", `mark-${props.job.status}`]} aria-hidden="true" />
      {STATUS_WORDS[props.job.status]}
      <Show when={props.job.statusUnknown}>
        <span class="vh"> (last recorded)</span>
      </Show>
    </span>
  );
}

const FAILURE_WORDS: Record<Failure["reason"], string> = {
  modelFailed: "the model’s provider failed the call",
  noOutput: "its agent ended without an accepted Output",
  runTimedOut: "a run went past its run timeout",
  modelBudgetExceeded: "its model calls’ cost reached its model budget",
  runFaulted: "its run broke on its Runner",
  runnerRemoved: "its Runner was removed before it ended",
  journalLost: "its Runner’s journal of it was lost",
};

export function BesideStatus(props: { job: ListedJob | Job; detailed?: boolean }) {
  return (
    <>
      <Show when={props.job.statusUnknown}>
        {(unknown) => (
          <span
            class="beside is-unknown"
            title={`${UNKNOWN_WORDS[unknown().reason]}, since ${FULL.format(unknown().since)}`}
          >
            <span class="mark mark-unknown" aria-hidden="true" />
            <span>
              Status unknown
              <Show
                when={props.detailed}
                fallback={<span class="condition-detail">{UNKNOWN_WORDS[unknown().reason]}</span>}
              >
                {" "}
                since <Instant value={unknown().since} format={TIME_SECONDS} />:{" "}
                {unknown().reason === "runnerDisconnected"
                  ? "its Runner is not connected"
                  : "its Runner has not reported it"}
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
      <Show when={props.job.blockedBy}>
        {(blockedBy) => (
          <span class="beside">
            <span class="mark mark-blocked" aria-hidden="true" />
            {BLOCKED_WORDS[blockedBy()]}
          </span>
        )}
      </Show>
      <Show when={props.job.status === "failed" ? props.job.failure.reason : undefined}>
        {(reason) => (
          <span class="beside">
            <code>{reason()}</code>
            <Show when={props.detailed && FAILURE_WORDS[reason()]}>
              {(words) => <>: {words()}</>}
            </Show>
          </span>
        )}
      </Show>
    </>
  );
}
