import type { UseQueryResult } from "@tanstack/solid-query";
import { Link } from "@tanstack/solid-router";
import type { Runner } from "contract";
import { Match, Show, Switch } from "solid-js";

import { formatCount } from "../format.ts";

type List = {
  to: "/jobs" | "/batches";
  filtered: boolean;
  after?: string;
};

export function ListEnd(props: List & { length: number; older?: string }) {
  const noun = () => (props.to === "/jobs" ? "jobs" : "Batches");
  return (
    <p class="list-end" id={`${props.to.slice(1)}-end`} tabindex="-1">
      <span>
        {formatCount(props.length)} read;{" "}
        {props.older
          ? "the hub gives no total."
          : props.filtered
            ? "no more match."
            : `there are no older ${noun()}.`}
      </span>
      <Show when={props.after}>
        <Link
          from={props.to}
          to="."
          search={(previous) => ({ ...previous, after: undefined })}
          class="stands-alone"
        >
          Newest {noun()}
        </Link>
      </Show>
      <Show when={props.older}>
        {(after) => (
          <Link
            from={props.to}
            to="."
            search={(previous) => ({ ...previous, after: after() })}
            class="stands-alone"
          >
            Older {noun()}
          </Link>
        )}
      </Show>
    </p>
  );
}

export function EmptyList(props: List & { runners?: Runner[] }) {
  const noun = () => (props.to === "/jobs" ? "jobs" : "Batches");
  return (
    <div class="empty">
      <Switch>
        <Match when={props.after}>
          <h2>No older {noun()}</h2>
          <p class="empty-act">
            <Link
              from={props.to}
              to="."
              search={(previous) => ({ ...previous, after: undefined })}
              class="stands-alone"
            >
              Newest {noun()}
            </Link>
          </p>
        </Match>
        <Match when={props.filtered}>
          <h2>No {props.to === "/jobs" ? "job" : "Batch"} matches these filters</h2>
          <p class="empty-act">
            <Link to={props.to} search={{}} class="stands-alone">
              Clear the filters
            </Link>
          </p>
        </Match>
        <Match when={true}>
          <h2>No {noun()} yet</h2>
          <Show
            when={props.runners?.every((runner) => !runner.connected)}
            fallback={
              <p>
                Submit a Batch of jobs with the CLI: <code>elflodge batches submit</code>
              </p>
            }
          >
            <p>Jobs run on Runners, and no Runner is connected to this hub.</p>
            <p class="empty-act">
              <Link to="/runners" class="stands-alone">
                Add Runner
              </Link>
            </p>
          </Show>
        </Match>
      </Switch>
    </div>
  );
}

// Reading data before the first Runner answer suspends the list, even after its own list arrived.
export function availableRunners(query: UseQueryResult<Runner[]>) {
  return query.dataUpdatedAt ? query.data : undefined;
}
