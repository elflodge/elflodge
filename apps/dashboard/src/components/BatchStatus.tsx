import type { ListedBatch } from "contract";
import { Show } from "solid-js";

import { BATCH_STATUS_WORDS } from "../batch.ts";
import { FULL, TIME_SECONDS } from "../format.ts";
import { Instant } from "./Instant.tsx";

export function BatchStatus(props: { batch: ListedBatch }) {
  return (
    <span class={["status-word", `s-${props.batch.status}`]}>
      <span class={["mark", `mark-${props.batch.status}`]} aria-hidden="true" />
      {BATCH_STATUS_WORDS[props.batch.status]}
    </span>
  );
}

export function BatchConditions(props: {
  batch: ListedBatch;
  detailed?: boolean;
  canary?: boolean;
}) {
  return (
    <>
      <Show when={props.batch.pausedBy}>
        {(by) => (
          <span class="beside">
            {props.detailed ? "By" : "by"} {by() === "breaker" ? "its failure breaker" : "a caller"}
          </span>
        )}
      </Show>
      <Show when={props.batch.pendingControl}>
        {(control) => (
          <span class="beside" title={`Asked ${FULL.format(control().requestedAt)}`}>
            <span class="mark mark-pending" aria-hidden="true" />
            Cancel asked
            <Show when={props.detailed}>
              {" "}
              <Instant value={control().requestedAt} format={TIME_SECONDS} />, waiting for its
              Runners
            </Show>
          </span>
        )}
      </Show>
      <Show when={props.canary}>
        <span class="beside">
          <span class="mark mark-blocked" aria-hidden="true" />
          Jobs waiting for its Canary
        </span>
      </Show>
    </>
  );
}
