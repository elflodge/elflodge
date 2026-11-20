import { useQuery } from "@tanstack/solid-query";
import { Outlet, createFileRoute, useChildMatches, useLocation } from "@tanstack/solid-router";
import { BATCH_ID_PATTERN, jobIdSchema, jobStatusSchema, type Runner } from "contract";
import { For, createMemo, createSignal } from "solid-js";
import * as z from "zod/mini";

import { STATUS_WORDS } from "../../../components/JobStatus.tsx";
import { ListFilters, StatusFilters, statusFilter } from "../../../components/ListFilters.tsx";
import { availableRunners, orpc } from "../../../query.ts";
import { optionalText } from "../../../search-form.ts";
import { shortIds } from "../../../short-ids.ts";

/**
 * The list's filters and its page, held in the address so that a link or a reload keeps them. A
 * value the list cannot take is dropped, and the filters' form then shows what is applied; one the
 * hub refuses, such as a Batch ID it does not allow, is the hub's to name when the list is read.
 */
export const jobsSearchSchema = z.object({
  status: statusFilter(jobStatusSchema),
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

/** The filters, as one form that applies them all at once. */
function Filters(props: { filters: z.infer<typeof jobsFiltersSchema>; runners: Runner[] }) {
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

  return (
    <ListFilters
      to="/jobs"
      schema={jobsSearchSchema}
      filters={props.filters}
      queryKey={(input) => orpc.jobs.list.queryKey({ input })}
      label="Filter the jobs"
      applied={filterCount(props.filters)}
      onReset={() => setDraftRunner(undefined)}
      firstRow={
        <>
          <StatusFilters
            statuses={jobStatusSchema.options}
            words={STATUS_WORDS}
            selected={props.filters.status}
          />
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
        </>
      }
    >
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
              <option value={option().id} defaultSelected={props.filters.runnerId === option().id}>
                {option().label}
              </option>
            )}
          </For>
        </select>
      </div>
    </ListFilters>
  );
}
