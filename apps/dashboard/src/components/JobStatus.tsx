import {
  blockedBySchema,
  failureSchema,
  statusUnknownReasonSchema,
  type BlockedBy,
  type Failure,
  type Job,
  type JobStatus as Status,
  type ListedJob,
  type OpenFailure,
  type OpenStatusUnknownReason,
  type StatusUnknownReason,
} from "contract";
import { Show } from "solid-js";
import type { ZodMiniType } from "zod/mini";

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

const BLOCKED_WORDS = {
  batchPausedByCaller: "Blocked: Batch paused",
  batchPausedByBreaker: "Blocked: failure breaker",
  batchCanary: "Waiting for Canary",
} satisfies Record<BlockedBy, string>;

const UNKNOWN_WORDS = {
  runnerDisconnected: { short: "Runner not connected", detail: "its Runner is not connected" },
  notReported: { short: "not reported", detail: "its Runner has not reported it" },
} satisfies Record<StatusUnknownReason, { short: string; detail: string }>;

function statusUnknownWords(reason: OpenStatusUnknownReason, form: "short" | "detail") {
  return renderReason(statusUnknownReasonSchema, reason, (value) => UNKNOWN_WORDS[value][form]);
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

const FAILURE_WORDS = {
  modelFailed: "Generating the next step failed.",
  noOutput: "its agent ended without an accepted Output",
  runTimedOut: "a run went past its run timeout",
  modelBudgetExceeded: "its model calls’ cost reached its model budget",
  runFaulted: "its run broke on its Runner",
  runnerRemoved: "its Runner was removed before it ended",
  journalLost: "its Runner’s journal of it was lost",
} satisfies Record<Failure["reason"], string>;

function renderReason<K extends string, T>(
  schema: ZodMiniType<K>,
  reason: string,
  known: (value: K) => T,
) {
  const parsed = schema.safeParse(reason);
  return parsed.success
    ? known(parsed.data)
    : `${JSON.stringify(reason)} (unknown to this dashboard version)`;
}

export function renderFailureReason<T>(
  reason: OpenFailure["reason"],
  known: (value: Failure["reason"], words: string) => T,
) {
  return renderReason(failureSchema.shape.reason, reason, (value) =>
    known(value, FAILURE_WORDS[value]),
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
        when={
          props.job.blockedBy === undefined
            ? undefined
            : renderReason(blockedBySchema, props.job.blockedBy, (value) => BLOCKED_WORDS[value])
        }
      >
        {(blockedBy) => (
          <span class="beside">
            <span class="mark mark-blocked" aria-hidden="true" />
            {blockedBy()}
          </span>
        )}
      </Show>
      <Show when={props.job.status === "failed" ? props.job.failure : undefined}>
        {(failure) => (
          <span class="beside">
            {renderFailureReason(failure().reason, (reason, words) => (
              <>
                <code>{reason}</code>
                <Show when={props.detailed}>: {words}</Show>
              </>
            ))}
          </span>
        )}
      </Show>
    </>
  );
}
