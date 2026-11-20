import { parseFormData } from "@orpc/openapi/helpers";
import { useQuery, type UseQueryResult } from "@tanstack/solid-query";
import {
  Link,
  Outlet,
  createFileRoute,
  useChildMatches,
  useLocation,
  useNavigate,
  useRouterState,
} from "@tanstack/solid-router";
import { BATCH_ID_PATTERN, jobIdSchema, jobStatusSchema, type Runner } from "contract";
import { For, Show, createEffect, createMemo, createSignal, onFlush } from "solid-js";
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
        z.array(jobStatusSchema).check(z.minLength(1)),
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
  // Start the form for the new address as navigation begins, before the list read settles.
  const search = useLocation({ select: (location) => jobsSearchSchema.parse(location.search) });
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
        <Filters search={search()} runners={availableRunners(runners) ?? []} />
      </div>
      <Outlet />
    </>
  );
}

/** The filters, as one form that applies them all at once. */
function Filters(props: { search: JobsSearch; runners: Runner[] }) {
  const navigate = useNavigate();
  const applied = () => filterCount(props.search);

  const [open, setOpen] = createSignal(false);
  let toggle: HTMLButtonElement | undefined;
  let apply: HTMLButtonElement | undefined;

  const focusTarget = () => (toggle?.checkVisibility() ? toggle : apply);
  // Each way to clear the filters removes its link. Wait for the unfiltered page to be visible.
  const cleared = useRouterState({
    select: ({ resolvedLocation }) =>
      resolvedLocation?.pathname === "/jobs"
        ? filterCount(jobsSearchSchema.parse(resolvedLocation.search)) === 0
        : undefined,
  });
  createEffect(cleared, (unfiltered, wasUnfiltered) => {
    if (unfiltered && wasUnfiltered === false) focusIfLost(focusTarget());
  });

  function closeFilters() {
    // Close in a separate flush so navigation cannot hold the panel open until its read settles.
    onFlush(() => setOpen(false));
    focusTarget()?.focus();
  }

  const { pending, onSubmit } = createFormAction((element) => {
    const form = new FormData(element);
    closeFilters();
    const search = jobsSearchSchema.parse(parseFormData(form));
    return navigate({ to: "/jobs", search });
  });

  const runnerIds = createMemo(() => shortIds(props.runners.map(({ id }) => id)));
  const runnerLabel = (runner: Runner) =>
    props.runners.some((other) => other.id !== runner.id && other.name === runner.name)
      ? `${runner.name} (${runnerIds().get(runner.id)})`
      : runner.name;
  const unlistedRunner = () => {
    const chosen = props.search.runnerId;
    return chosen && !runnerIds().has(chosen) ? chosen : undefined;
  };

  return (
    <div class="filters">
      <button
        type="button"
        class="filter-toggle"
        aria-expanded={open() ? "true" : "false"}
        aria-controls="jobs-filters"
        ref={(element) => {
          toggle = element;
        }}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        Filters
        <Show when={applied() > 0}> ({formatCount(applied())} applied)</Show>
      </button>
      {/* Each applied search starts a fresh form. Edits then belong to its native controls. */}
      <Show when={props.search} keyed>
        {(initial) => (
          <form
            id="jobs-filters"
            class="filters-form"
            aria-label="Filter the jobs"
            onSubmit={async (event) => {
              await onSubmit(event);
              // Clear can replace a pending read while Apply is still disabled.
              focusIfLost(apply);
            }}
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
                        defaultChecked={initial.status?.includes(status) ?? false}
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
                  <option value="" defaultSelected={initial.statusUnknown === undefined}>
                    Any
                  </option>
                  <option value="true" defaultSelected={initial.statusUnknown === true}>
                    Only status unknown
                  </option>
                  <option value="false" defaultSelected={initial.statusUnknown === false}>
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
                  defaultValue={initial.batchId ?? ""}
                />
              </div>
              <div class="filter-field">
                <label for="jobs-runner">Runner</label>
                <select id="jobs-runner" name="runnerId">
                  <option value="" defaultSelected={initial.runnerId === undefined}>
                    Any
                  </option>
                  <For each={props.runners}>
                    {(runner) => (
                      <option value={runner.id} defaultSelected={initial.runnerId === runner.id}>
                        {runnerLabel(runner)}
                      </option>
                    )}
                  </For>
                  <Show when={unlistedRunner()}>
                    {(id) => (
                      <option value={id()} defaultSelected>
                        Runner ID: {id()}
                      </option>
                    )}
                  </Show>
                </select>
              </div>
              <span class="filter-act">
                <button
                  type="submit"
                  class="primary"
                  disabled={pending()}
                  ref={(element) => {
                    apply = element;
                  }}
                >
                  Apply
                </button>
                <Show when={applied() > 0}>
                  <Link
                    activeOptions={{ exact: true }}
                    to="/jobs"
                    search={{}}
                    class="stands-alone"
                    onClick={closeFilters}
                  >
                    Clear
                  </Link>
                </Show>
              </span>
            </div>
          </form>
        )}
      </Show>
    </div>
  );
}
