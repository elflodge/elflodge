import type { JSX } from "@solidjs/web";
import { Link } from "@tanstack/solid-router";
import { For, Show } from "solid-js";
import * as z from "zod/mini";

import { createFormAction } from "../form.ts";
import { formatCount } from "../format.ts";
import { listPages } from "../list-pages.ts";

export const optionalText = z.catch(z.optional(z.string().check(z.minLength(1))), undefined);

// An address with one status has a scalar. Repeated statuses and FormData.getAll give an array.
export function statusFilter<T extends z.ZodMiniType<string>>(status: T) {
  return z.catch(
    z.optional(
      z.union([
        z.array(status).check(z.minLength(1)),
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
              checked={props.selected?.includes(status) ?? false}
            />
            <span class={["mark", `mark-${status}`]} aria-hidden="true" />
            {props.words[status]}
          </label>
        )}
      </For>
    </fieldset>
  );
}

export function ListFilters(props: {
  to: keyof typeof listPages;
  applied: number;
  label: string;
  submit: (values: Record<string, unknown>) => Promise<void>;
  firstRow: JSX.Element;
  children: JSX.Element;
}) {
  let toggle: HTMLButtonElement | undefined;
  const id = () => listPages[props.to].filters;
  // CSS reads aria-expanded directly so a press takes effect even during a pending form action.
  function closeFilters() {
    if (toggle) {
      toggle.ariaExpanded = "false";
      toggle.focus();
    }
  }
  const { pending, onSubmit } = createFormAction((form) => {
    closeFilters();
    const data = new FormData(form);
    return props.submit({ ...Object.fromEntries(data), status: data.getAll("status") });
  });
  return (
    <div class="filters">
      <button
        type="button"
        class="filter-toggle"
        aria-expanded="false"
        aria-controls={id()}
        ref={(element) => {
          toggle = element;
        }}
        onClick={({ currentTarget }) => {
          currentTarget.ariaExpanded = String(currentTarget.ariaExpanded !== "true");
        }}
      >
        Filters<Show when={props.applied > 0}> ({formatCount(props.applied)} applied)</Show>
      </button>
      <form id={id()} class="filters-form" aria-label={props.label} onSubmit={onSubmit}>
        <div class="filters-row">{props.firstRow}</div>
        <div class="filters-row">
          {props.children}
          <span class="filter-act">
            <button type="submit" class="primary" disabled={pending()}>
              Apply
            </button>
            <Show when={props.applied > 0}>
              <Link to={props.to} search={{}} class="stands-alone" onClick={closeFilters}>
                Clear
              </Link>
            </Show>
          </span>
        </div>
      </form>
    </div>
  );
}
