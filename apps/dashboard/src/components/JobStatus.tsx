import type { BlockedBy, Job, JobStatus as Status, ListedJob, StatusUnknownReason } from "contract";
import { Show } from "solid-js";

import { FULL } from "../format.ts";

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
  batchCanary: "Blocked: Canary running",
};

const UNKNOWN_WORDS: Record<StatusUnknownReason, string> = {
  runnerDisconnected: "Status unknown: Runner not connected",
  notReported: "Status unknown: not reported",
};

const CONTROL_WORDS: Record<NonNullable<Job["pendingControl"]>["type"], string> = {
  pause: "Pause asked",
  cancel: "Cancel asked",
  delete: "Delete asked",
};

/**
 * A job's status, as a mark and a word, and beside it each condition the job reports with it: a
 * status the hub cannot confirm, a control its Runner has not yet acted on, what blocks it, and why
 * it failed. While the status is unknown, the word is the last status its Runner confirmed.
 */
export function JobStatus(props: { job: ListedJob | Job }) {
  return (
    <span class={["status", { "is-unknown": props.job.statusUnknown !== undefined }]}>
      <span class={["status-word", `s-${props.job.status}`]}>
        <span class={["mark", `mark-${props.job.status}`]} aria-hidden="true" />
        {STATUS_WORDS[props.job.status]}
        <Show when={props.job.statusUnknown}>
          <span class="vh"> (last confirmed)</span>
        </Show>
      </span>
      <Show when={props.job.statusUnknown}>
        {(unknown) => (
          <span class="beside is-unknown" title={`Since ${FULL.format(unknown().since)}`}>
            <span class="mark mark-unknown" aria-hidden="true" />
            {UNKNOWN_WORDS[unknown().reason]}
          </span>
        )}
      </Show>
      <Show when={props.job.pendingControl}>
        {(control) => (
          <span class="beside" title={`Asked ${FULL.format(control().requestedAt)}`}>
            <span class="mark mark-pending" aria-hidden="true" />
            {CONTROL_WORDS[control().type]}
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
          </span>
        )}
      </Show>
    </span>
  );
}
