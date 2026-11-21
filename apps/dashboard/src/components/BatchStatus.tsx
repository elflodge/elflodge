import type { ListedBatch } from "contract";
import { Show } from "solid-js";

import { BATCH_STATUS_WORDS } from "../batch.ts";
import { formatCount, FULL, plural, TIME_SECONDS } from "../format.ts";
import { Instant } from "./Instant.tsx";

export function BatchStatus(props: { batch: ListedBatch }) {
  return (
    <span class={["status-word", `s-${props.batch.status}`]}>
      <span class={["mark", `mark-${props.batch.status}`]} aria-hidden="true" />
      {BATCH_STATUS_WORDS[props.batch.status]}
    </span>
  );
}

export function BatchConditions(props: { batch: ListedBatch; detailed?: boolean }) {
  return (
    <>
      <Show when={props.batch.pausedBy}>
        {(by) => (
          <span class="beside">
            {props.detailed ? "By" : "by"} {by() === "breaker" ? "its failure breaker" : "a caller"}
          </span>
        )}
      </Show>
      {/* Read directly: each poll brings a new Date in it, and a keyed child would be rebuilt every
          time, dropping the tooltip of its title (AGENTS.md). */}
      <Show when={props.batch.pendingControl}>
        <span
          class="beside"
          title={
            props.batch.pendingControl &&
            `Asked ${FULL.format(props.batch.pendingControl.requestedAt)}`
          }
        >
          <span class="mark mark-pending" aria-hidden="true" />
          Cancel asked
          <Show when={props.detailed}>
            {" "}
            <Instant value={props.batch.pendingControl?.requestedAt} format={TIME_SECONDS} />,
            waiting for its Runners
          </Show>
        </span>
      </Show>
      <Show when={props.batch.blockedJobCounts.batchCanary}>
        {(count) => (
          <span class="beside">
            <span class="mark mark-blocked" aria-hidden="true" />
            {formatCount(count())} {plural(count(), "job", "jobs")} waiting for its Canary
          </span>
        )}
      </Show>
    </>
  );
}
