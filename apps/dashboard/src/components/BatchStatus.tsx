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
  // The pending control is read directly, not keyed: on the Batch page each poll brings a new Date
  // in it, which would rebuild a keyed child and drop the tooltip of its title.
  const control = () => props.batch.pendingControl;
  const asked = () => {
    const value = control();
    return value && `Asked ${FULL.format(value.requestedAt)}`;
  };
  return (
    <>
      <Show when={props.batch.pausedBy} keyed>
        {(by) => (
          <span class="beside">
            {props.detailed ? "By" : "by"} {by === "breaker" ? "its failure breaker" : "a caller"}
          </span>
        )}
      </Show>
      <Show when={control()}>
        <span class="beside" title={asked()}>
          <span class="mark mark-pending" aria-hidden="true" />
          Cancel asked
          <Show when={props.detailed}>
            {" "}
            <Instant value={control()?.requestedAt} format={TIME_SECONDS} />, waiting for its
            Runners
          </Show>
        </span>
      </Show>
      <Show when={props.batch.blockedJobCounts.batchCanary} keyed>
        {(count) => (
          <span class="beside">
            <span class="mark mark-blocked" aria-hidden="true" />
            {formatCount(count)} {plural(count, "job", "jobs")} waiting for its Canary
          </span>
        )}
      </Show>
    </>
  );
}
