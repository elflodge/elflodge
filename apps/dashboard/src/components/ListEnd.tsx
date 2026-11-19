import { Link } from "@tanstack/solid-router";
import type { Runner } from "contract";
import { Match, Show, Switch } from "solid-js";

import { formatCount } from "../format.ts";
import { listPages } from "../list-pages.ts";

type ListAddressState = {
  to: keyof typeof listPages;
  filtered: boolean;
  after?: string;
};

/** The way to newer and older pages, where there are any. */
export function ListEnd(props: ListAddressState & { length: number; older?: string }) {
  const list = () => listPages[props.to];
  return (
    <p class="list-end" id={list().end} tabindex="-1">
      <span>
        {formatCount(props.length)} read;{" "}
        {props.older
          ? "the hub gives no total."
          : props.filtered
            ? "no more match."
            : `there are no older ${list().plural}.`}
      </span>
      <Show when={props.after}>
        <Link
          from={props.to}
          to="."
          search={(previous) => ({ ...previous, after: undefined })}
          class="stands-alone"
        >
          Newest {list().plural}
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
            Older {list().plural}
          </Link>
        )}
      </Show>
    </p>
  );
}

/**
 * What an empty list means, and what to do next: clear the filters that match nothing, or, on an
 * empty hub, connect a Runner first, then submit a Batch.
 */
export function EmptyList(props: ListAddressState & { runners?: Runner[] }) {
  const list = () => listPages[props.to];
  return (
    <div class="empty">
      <Switch>
        <Match when={props.after}>
          <h2>No older {list().plural}</h2>
          <p class="empty-act">
            <Link
              from={props.to}
              to="."
              search={(previous) => ({ ...previous, after: undefined })}
              class="stands-alone"
            >
              Newest {list().plural}
            </Link>
          </p>
        </Match>
        <Match when={props.filtered}>
          <h2>No {list().singular} matches these filters</h2>
          <p class="empty-act">
            <Link to={props.to} search={{}} class="stands-alone">
              Clear the filters
            </Link>
          </p>
        </Match>
        <Match when={true}>
          <h2>No {list().plural} yet</h2>
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
