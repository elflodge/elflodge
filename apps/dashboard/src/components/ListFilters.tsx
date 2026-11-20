import type { JSX } from "@solidjs/web";
import type { QueryKey } from "@tanstack/solid-query";
import { Link } from "@tanstack/solid-router";
import { For, Show, createEffect, createSignal, onFlush } from "solid-js";
import * as z from "zod/mini";

import { focusIfLost, focusAfterLinkDrops } from "../form.ts";
import { formatCount } from "../format.ts";
import { listPages } from "../list-pages.ts";
import { createSearchForm } from "../search-form.ts";

// One checked status is a scalar. Equal sets in any URL order share one list read.
export function statusFilter<T extends string>(status: z.ZodMiniType<T> & { options: T[] }) {
  return z.catch(
    z.optional(
      z.union([
        z.pipe(
          z.array(status).check(z.minLength(1)),
          z.transform((selected) => status.options.filter((value) => selected.includes(value))),
        ),
        z.pipe(
          status,
          z.transform((one) => [one]),
        ),
      ]),
    ),
    undefined,
  );
}

export function StatusFilters<T extends string>(props: {
  statuses: readonly T[];
  words: Record<T, string>;
  selected?: T[];
}) {
  return (
    <fieldset class="check-group is-inline">
      <legend>Status</legend>
      <For each={props.statuses}>
        {(status) => (
          <label class="check">
            <input
              type="checkbox"
              name="status"
              value={status}
              defaultChecked={props.selected?.includes(status) ?? false}
            />
            <span class={["mark", `mark-${status}`]} aria-hidden="true" />
            {props.words[status]}
          </label>
        )}
      </For>
    </fieldset>
  );
}

/** Apply and Clear return focus to the visible filter control, including after error recovery. */
function filterFocusTarget(to: keyof typeof listPages) {
  const id = listPages[to].filters;
  const toggle = document.querySelector<HTMLButtonElement>(`button[aria-controls="${id}"]`);
  return toggle?.checkVisibility()
    ? toggle
    : document.querySelector<HTMLButtonElement>(`#${id} button[type=submit]`);
}

export function ClearFiltersLink(props: {
  to: keyof typeof listPages;
  children: string;
  closePanel?: () => void;
}) {
  const target = () => filterFocusTarget(props.to);
  const returnToFilters = focusAfterLinkDrops(target, () => {
    props.closePanel?.();
    const control = target();
    if (control?.checkVisibility()) control.focus();
  });
  return (
    <Link
      activeOptions={{ exact: true }}
      to={props.to}
      search={{}}
      class="stands-alone"
      onClick={returnToFilters}
    >
      {props.children}
    </Link>
  );
}

export function ListFilters<T extends Record<string, unknown>>(props: {
  to: keyof typeof listPages;
  schema: z.ZodMiniType<T>;
  filters: T;
  queryKey: (filters: T) => QueryKey;
  applied: number;
  label: string;
  onReset: () => void;
  firstRow: JSX.Element;
  children: JSX.Element;
}) {
  const id = () => listPages[props.to].filters;
  const [open, setOpen] = createSignal(false);

  function closePanel() {
    // Close in a separate flush so navigation cannot hold the panel open until its read settles.
    onFlush(() => setOpen(false));
  }

  const { pending, onSubmit, resetForNavigation } = createSearchForm({
    to: props.to,
    schema: props.schema,
    queryKey: props.queryKey,
    beforeSubmit() {
      closePanel();
      filterFocusTarget(props.to)?.focus();
    },
  });

  // Defaults follow the applied filters across navigation.
  let form: HTMLFormElement | undefined;
  createEffect(
    () => props.filters,
    () => {
      if (form) resetForNavigation(form);
      // Back can remove the focused Clear link along with the last filter.
      if (!props.applied) focusIfLost(filterFocusTarget(props.to));
    },
    { defer: true },
  );

  return (
    <div class="filters">
      <button
        type="button"
        class="filter-toggle"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={id()}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        Filters
        <Show when={props.applied > 0}> ({formatCount(props.applied)} applied)</Show>
      </button>
      <form
        ref={(element) => {
          form = element;
        }}
        id={id()}
        class="filters-form"
        aria-label={props.label}
        onReset={props.onReset}
        onSubmit={onSubmit}
      >
        <div class="filters-row">{props.firstRow}</div>
        <div class="filters-row">
          {props.children}
          <span class="filter-act">
            <button type="submit" class="primary" aria-disabled={pending() ? "true" : undefined}>
              Apply
            </button>
            <Show when={props.applied > 0}>
              <ClearFiltersLink to={props.to} closePanel={closePanel}>
                Clear
              </ClearFiltersLink>
            </Show>
          </span>
        </div>
      </form>
    </div>
  );
}
