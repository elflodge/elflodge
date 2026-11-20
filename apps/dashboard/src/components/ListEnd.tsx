import { Link, useRouter, useSearch } from "@tanstack/solid-router";
import type { Runner } from "contract";
import { Match, Show, Switch } from "solid-js";

import { focusIfLost } from "../form.ts";
import { formatCount } from "../format.ts";
import { listPages } from "../list-pages.ts";
import { ClearFiltersLink } from "./ListFilters.tsx";

type ListAddressState = {
  to: keyof typeof listPages;
  filtered: boolean;
  after?: string;
};

/** If paging removes the link the reader used, keep their place at the new list end. */
export function PagingLink(props: { to: keyof typeof listPages; after?: string }) {
  const router = useRouter();
  const search = useSearch({ strict: false });
  function follow(event: MouseEvent & { currentTarget: HTMLAnchorElement }) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    const link = event.currentTarget;
    const destination = link.href;
    const end = listPages[props.to].end;
    const unsubscribe = router.subscribe("onResolved", () => {
      unsubscribe();
      if (!link.isConnected && location.href === destination)
        focusIfLost(document.getElementById(end));
    });
  }
  return (
    <Link
      activeOptions={{ exact: true }}
      from={props.to}
      to="."
      search={{ ...search(), after: props.after }}
      class="stands-alone"
      onClick={follow}
    >
      {props.after ? "Older" : "Newest"} {listPages[props.to].plural}
    </Link>
  );
}

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
        <PagingLink to={props.to} />
      </Show>
      <Show when={props.older}>{(after) => <PagingLink to={props.to} after={after()} />}</Show>
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
            <PagingLink to={props.to} />
          </p>
        </Match>
        <Match when={props.filtered}>
          <h2>No {list().singular} matches these filters</h2>
          <p class="empty-act">
            <ClearFiltersLink to={props.to}>Clear the filters</ClearFiltersLink>
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
