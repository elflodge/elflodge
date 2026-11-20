import { parseFormData } from "@orpc/openapi/helpers";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/solid-query";
import {
  Link,
  Outlet,
  createFileRoute,
  deepEqual,
  linkOptions,
  trimPathRight,
  useChildMatches,
  useLocation,
  useRouter,
} from "@tanstack/solid-router";
import { BATCH_ID_PATTERN, jobIdSchema, jobStatusSchema, type Runner } from "contract";
import { For, Show, createEffect, createMemo, createSignal, onFlush, onSettled } from "solid-js";
import * as z from "zod/mini";

import { STATUS_WORDS } from "../../../components/JobStatus.tsx";
import { createFormAction, focusIfLost } from "../../../form.ts";
import { formatCount } from "../../../format.ts";
import { orpc } from "../../../query.ts";
import { shortIds } from "../../../short-ids.ts";

const STATUSES = jobStatusSchema.options;
const optionalText = z.catch(z.optional(z.string().check(z.minLength(1))), undefined);

/**
 * The list's filters and its page, held in the address so that a link or a reload keeps them. A
 * value the list cannot take is dropped, and the filters' form then shows what is applied; one the
 * hub refuses, such as a Batch ID it does not allow, is the hub's to name when the list is read.
 */
export const jobsSearchSchema = z.object({
  status: z.catch(
    z.optional(
      z.union([
        // Links can list the same checked statuses in different orders. They share one Jobs read.
        z.pipe(
          z.array(jobStatusSchema).check(z.minLength(1)),
          z.transform((statuses) => STATUSES.filter((status) => statuses.includes(status))),
        ),
        z.pipe(
          jobStatusSchema,
          z.transform((status) => [status]),
        ),
      ]),
    ),
    undefined,
  ),
  statusUnknown: z.catch(
    z.optional(
      z.union([
        z.boolean(),
        z.stringbool({ truthy: ["true"], falsy: ["false"], case: "sensitive" }),
      ]),
    ),
    undefined,
  ),
  batchId: optionalText,
  runnerId: optionalText,
  after: z.catch(z.optional(jobIdSchema), undefined),
});
const jobsFiltersSchema = z.omit(jobsSearchSchema, { after: true });
export type JobsSearch = z.infer<typeof jobsSearchSchema>;

/** How many of the filters `search` applies; the page it reads from is not one. */
export function filterCount(search: JobsSearch) {
  return [
    search.status?.length,
    search.statusUnknown !== undefined,
    search.batchId,
    search.runnerId,
  ].filter(Boolean).length;
}

export const Route = createFileRoute("/_signed-in/_member/jobs")({
  validateSearch: jobsSearchSchema,
  component: Jobs,
});

// Reading data before the first Runner answer suspends the Jobs page, even after its own list arrived.
export function availableRunners(query: UseQueryResult<Runner[]>) {
  return query.dataUpdatedAt ? query.data : undefined;
}

function Jobs() {
  // The form follows the filters as navigation begins. Paging changes only the list.
  const filters = useLocation({ select: (location) => jobsFiltersSchema.parse(location.search) });
  const listFailed = useChildMatches({
    select: (matches) => matches.some((match) => match.status === "error"),
  });
  const runners = useQuery(() => orpc.runners.list.queryOptions());
  return (
    <>
      <div hidden={listFailed()}>
        <div class="head">
          <h1>Jobs</h1>
        </div>
        <Filters filters={filters()} runners={availableRunners(runners) ?? []} />
      </div>
      <Outlet />
    </>
  );
}

/** Apply and Clear return focus to the visible filter control, including after error recovery. */
function filterFocusTarget() {
  const toggle = document.querySelector<HTMLButtonElement>('button[aria-controls="jobs-filters"]');
  return toggle?.checkVisibility()
    ? toggle
    : document.querySelector<HTMLButtonElement>("#jobs-filters button[type=submit]");
}

export function ClearFiltersLink(props: { children: string; closePanel?: () => void }) {
  let focusWhenVisible = false;
  function returnToFilters(event: MouseEvent) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
      return;
    props.closePanel?.();
    const target = filterFocusTarget();
    if (target?.checkVisibility()) target.focus();
    else focusWhenVisible = true;
  }
  // A refused read hides the form. Its recovery link disappears when the form is visible again.
  onSettled(() => () => {
    if (focusWhenVisible) onFlush(() => focusIfLost(filterFocusTarget()));
  });
  return (
    <Link
      activeOptions={{ exact: true }}
      to="/jobs"
      search={{}}
      class="stands-alone"
      onClick={returnToFilters}
    >
      {props.children}
    </Link>
  );
}

/** The filters, as one form that applies them all at once. */
function Filters(props: { filters: z.infer<typeof jobsFiltersSchema>; runners: Runner[] }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const applied = () => filterCount(props.filters);

  const [open, setOpen] = createSignal(false);

  function closePanel() {
    // Close in a separate flush so navigation cannot hold the panel open until its read settles.
    onFlush(() => setOpen(false));
  }

  const { pending, onSubmit } = createFormAction((element) => {
    const form = new FormData(element);
    closePanel();
    filterFocusTarget()?.focus();
    const search = jobsFiltersSchema.parse(parseFormData(form));
    const destination = linkOptions({ to: "/jobs", search });
    const current = router.latestLocation;
    const next = router.buildLocation(destination);
    // The current location holds URL values: one status is text and a page cursor is still present.
    if (
      trimPathRight(current.pathname) === trimPathRight(next.pathname) &&
      deepEqual(jobsSearchSchema.parse(current.search), next.search)
    ) {
      // The router loads an unchanged location inside the Solid action, which can hold the commit
      // navigation is waiting for. Apply here only needs to refresh the displayed list.
      return queryClient.invalidateQueries({
        queryKey: orpc.jobs.list.queryKey({ input: search }),
        exact: true,
      });
    }
    return router.navigate(destination);
  });

  const [draftRunner, setDraftRunner] = createSignal<string>();
  // Keep a chosen Runner identifiable when the roster changes, even before Apply.
  const runnerOptions = createMemo(() => {
    const ids = shortIds(props.runners.map(({ id }) => id));
    const options = props.runners.map(({ id, name }) => ({
      id,
      label: props.runners.some((other) => other.id !== id && other.name === name)
        ? `${name} (${ids.get(id)})`
        : name,
    }));
    for (const id of [props.filters.runnerId, draftRunner()]) {
      if (id && !options.some((option) => option.id === id))
        options.push({ id, label: `Runner ID: ${id}` });
    }
    return options;
  });

  // Defaults follow the address. Reset edits only when the applied filters change.
  let form: HTMLFormElement | undefined;
  createEffect(
    () => props.filters,
    () => {
      form?.reset();
      // Back can remove the focused Clear link along with the last filter.
      if (!applied()) focusIfLost(filterFocusTarget());
    },
    { defer: true },
  );

  return (
    <div class="filters">
      <button
        type="button"
        class="filter-toggle"
        aria-expanded={open() ? "true" : "false"}
        aria-controls="jobs-filters"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        Filters
        <Show when={applied() > 0}> ({formatCount(applied())} applied)</Show>
      </button>
      <form
        ref={(element) => {
          form = element;
        }}
        id="jobs-filters"
        class="filters-form"
        aria-label="Filter the jobs"
        onReset={() => setDraftRunner(undefined)}
        onSubmit={onSubmit}
      >
        <div class="filters-row">
          <fieldset class="check-group is-inline">
            <legend>Status</legend>
            <For each={STATUSES}>
              {(status) => (
                <label class="check">
                  <input
                    type="checkbox"
                    name="status"
                    value={status}
                    defaultChecked={props.filters.status?.includes(status) ?? false}
                  />
                  <span class={["mark", `mark-${status}`]} aria-hidden="true" />
                  {STATUS_WORDS[status]}
                </label>
              )}
            </For>
          </fieldset>
          <div class="filter-field">
            <label for="jobs-status-unknown">Status unknown</label>
            <select id="jobs-status-unknown" name="statusUnknown">
              <option value="" defaultSelected={props.filters.statusUnknown === undefined}>
                Any
              </option>
              <option value="true" defaultSelected={props.filters.statusUnknown === true}>
                Only status unknown
              </option>
              <option value="false" defaultSelected={props.filters.statusUnknown === false}>
                Only status known
              </option>
            </select>
          </div>
        </div>
        <div class="filters-row">
          <div class="filter-field">
            <label for="jobs-batch">Batch</label>
            <input
              id="jobs-batch"
              name="batchId"
              pattern={BATCH_ID_PATTERN.source}
              title="Use letters, digits, underscores or hyphens. Start with a letter, digit or underscore."
              defaultValue={props.filters.batchId ?? ""}
            />
          </div>
          <div class="filter-field">
            <label for="jobs-runner">Runner</label>
            <select
              id="jobs-runner"
              name="runnerId"
              onChange={(event) => setDraftRunner(event.currentTarget.value)}
            >
              <option value="" defaultSelected={props.filters.runnerId === undefined}>
                Any
              </option>
              <For each={runnerOptions()} keyed={(option) => option.id}>
                {(option) => (
                  <option
                    value={option().id}
                    defaultSelected={props.filters.runnerId === option().id}
                  >
                    {option().label}
                  </option>
                )}
              </For>
            </select>
          </div>
          <span class="filter-act">
            <button type="submit" class="primary" aria-disabled={pending() ? "true" : undefined}>
              Apply
            </button>
            <Show when={applied() > 0}>
              <ClearFiltersLink closePanel={closePanel}>Clear</ClearFiltersLink>
            </Show>
          </span>
        </div>
      </form>
    </div>
  );
}
