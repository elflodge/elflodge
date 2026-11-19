import { useQuery } from "@tanstack/solid-query";
import type { UseQueryResult } from "@tanstack/solid-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/solid-router";
import { jobStatusSchema } from "contract";
import type { JobRunner, JobsPage, ListedJob, Runner } from "contract";
import { Errored, For, Loading, Match, Show, Switch } from "solid-js";
import * as z from "zod/mini";

import { hubFailureMessage, readFromHub } from "../../../api-client.ts";
import { Instant } from "../../../components/Instant.tsx";
import { JobStatus, STATUS_WORDS } from "../../../components/JobStatus.tsx";
import { Notice } from "../../../components/Notice.tsx";
import { fieldText } from "../../../form.ts";
import { formatCount, formatUsd, timeZoneNote } from "../../../format.ts";
import { orpc } from "../../../query.ts";

/** How many jobs a page holds: the hub's own default. */
const PAGE = 50;

/** How often the list is read again while the page is visible. */
const REFRESH = 15_000;

const STATUSES = jobStatusSchema.options;

/**
 * The list's filters and its page, held in the address so that a link or a reload keeps them. A
 * value the list cannot take is dropped, and the filters' form then shows what is applied; one the
 * hub refuses, such as a Batch ID it does not allow, is the hub's to name when the list is read.
 */
const jobsSearchSchema = z.object({
  status: z.catch(z.optional(z.array(jobStatusSchema)), undefined),
  statusUnknown: z.catch(z.optional(z.boolean()), undefined),
  batchId: z.catch(z.optional(z.string()), undefined),
  runnerId: z.catch(z.optional(z.string()), undefined),
  after: z.catch(z.optional(z.string()), undefined),
});
type JobsSearch = z.infer<typeof jobsSearchSchema>;

/** The read of `GET /jobs` that `search` asks for. */
function listInput(search: JobsSearch) {
  // No status is any status, as for the hub; an empty list is left out rather than sent.
  return { ...search, status: search.status?.length ? search.status : undefined, limit: PAGE };
}

/** How many of the filters `search` applies; the page it reads from is not one. */
function filterCount(search: JobsSearch) {
  return [
    search.status?.length,
    search.statusUnknown !== undefined,
    search.batchId,
    search.runnerId,
  ].filter(Boolean).length;
}

export const Route = createFileRoute("/_signed-in/_member/jobs")({
  validateSearch: jobsSearchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    if (context.membership.status !== "member") return;
    await readFromHub("The jobs", () =>
      context.queryClient.query(
        orpc.jobs.list.queryOptions({ input: listInput(deps), staleTime: "static" }),
      ),
    );
  },
  // Shown while another page or other filters are read for longer than the router's wait, rather
  // than the list read before, under an address that no longer says what it shows.
  pendingComponent: Reading,
  component: Jobs,
});

/** The page while its list is read. */
function Reading() {
  return (
    <>
      <div class="head">
        <h1>Jobs</h1>
      </div>
      <p class="list-note">Reading the jobs…</p>
    </>
  );
}

/**
 * The Organization's jobs, newest first, a page at a time, narrowed by the filters in the address.
 * An empty hub says what to do next.
 */
function Jobs() {
  const search = Route.useSearch();
  const jobs = useQuery(() =>
    orpc.jobs.list.queryOptions({ input: listInput(search()), refetchInterval: REFRESH }),
  );
  // The strip reads the same, and reads it again.
  const runners = useQuery(() => orpc.runners.list.queryOptions());

  return (
    <>
      <div class="head">
        <h1>Jobs</h1>
      </div>
      <Filters search={search()} runners={runners.isSuccess ? runners.data : undefined} />
      <Errored
        fallback={(_error, reset) => (
          <ReadFailed
            error={jobs.error}
            retry={() => {
              reset();
              void jobs.refetch();
            }}
          />
        )}
      >
        {/* Other filters or another page show nothing until their read answers; the same list read
            again stays as it is meanwhile. */}
        <Loading fallback={<p class="list-note">Reading the jobs…</p>} on={search()}>
          {/* While the latest read has failed, what an earlier one read is not shown as current. */}
          <Show
            when={!jobs.isError && jobs.data}
            fallback={<ReadFailed error={jobs.error} retry={() => void jobs.refetch()} />}
          >
            {(page) => (
              <Show
                when={page().jobs.length > 0}
                fallback={<NoJobs search={search()} runners={runners} />}
              >
                <p class="note">{timeZoneNote()}</p>
                <JobsTable jobs={page().jobs} />
                <Paging search={search()} page={page()} />
              </Show>
            )}
          </Show>
        </Loading>
      </Errored>
    </>
  );
}

/** The filters, as one form that applies them all at once. */
function Filters(props: { search: JobsSearch; runners: Runner[] | undefined }) {
  const navigate = useNavigate();
  const applied = () => filterCount(props.search);

  function apply(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const chosen = form.getAll("status");
    const unknown = fieldText(form, "statusUnknown");
    const batchId = fieldText(form, "batchId").trim();
    const runnerId = fieldText(form, "runnerId");
    const status = STATUSES.filter((value) => chosen.includes(value));
    void navigate({
      to: "/jobs",
      search: {
        status: status.length > 0 ? status : undefined,
        statusUnknown: unknown === "true" ? true : unknown === "false" ? false : undefined,
        batchId: batchId || undefined,
        runnerId: runnerId || undefined,
      },
    });
  }

  /** The Runners to choose from, with the one chosen even when the hub no longer lists it. */
  const choices = () => {
    const listed = props.runners ?? [];
    const chosen = props.search.runnerId;
    return chosen === undefined || listed.some((runner) => runner.id === chosen)
      ? listed
      : [...listed, { id: chosen, name: chosen }];
  };
  /** A Runner's name, with its ID where another Runner has the same name. */
  const runnerLabel = (runner: { id: string; name: string }) =>
    choices().some((other) => other.id !== runner.id && other.name === runner.name)
      ? `${runner.name} (${runner.id})`
      : runner.name;

  return (
    <details class="filters" open={applied() > 0}>
      <summary>
        Filters
        <Show when={applied() > 0}> ({formatCount(applied())} applied)</Show>
      </summary>
      <form class="filters-form" aria-label="Filter the jobs" onSubmit={apply}>
        <fieldset class="filter-status">
          <legend>Status</legend>
          <For each={STATUSES}>
            {(status) => (
              <label class="check">
                <input
                  type="checkbox"
                  name="status"
                  value={status}
                  checked={props.search.status?.includes(status) ?? false}
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
            <option value="" selected={props.search.statusUnknown === undefined}>
              Any
            </option>
            <option value="true" selected={props.search.statusUnknown === true}>
              Only status unknown
            </option>
            <option value="false" selected={props.search.statusUnknown === false}>
              Only status known
            </option>
          </select>
        </div>
        <div class="filter-field">
          <label for="jobs-batch">Batch</label>
          <input id="jobs-batch" name="batchId" value={props.search.batchId ?? ""} />
        </div>
        <div class="filter-field">
          <label for="jobs-runner">Runner</label>
          <select id="jobs-runner" name="runnerId">
            <option value="" selected={props.search.runnerId === undefined}>
              Any
            </option>
            <For each={choices()}>
              {(runner) => (
                <option value={runner.id} selected={props.search.runnerId === runner.id}>
                  {runnerLabel(runner)}
                </option>
              )}
            </For>
          </select>
        </div>
        <span class="filter-act">
          <button type="submit" class="primary">
            Apply
          </button>
          <Show when={applied() > 0}>
            <Link to="/jobs" search={{}} class="stands-alone">
              Clear
            </Link>
          </Show>
        </span>
      </form>
    </details>
  );
}

/** A page of jobs, one ruled line a job. */
function JobsTable(props: { jobs: ListedJob[] }) {
  return (
    <table class="records is-wide" role="table">
      <caption class="vh">Jobs</caption>
      <thead role="rowgroup">
        <tr role="row">
          <th scope="col" role="columnheader">
            Job
          </th>
          <th scope="col" role="columnheader">
            Status
          </th>
          <th scope="col" role="columnheader">
            Batch
          </th>
          <th scope="col" role="columnheader">
            Runner
          </th>
          <th scope="col" role="columnheader">
            Time
          </th>
          <th scope="col" role="columnheader" class="num">
            Tokens
          </th>
          <th scope="col" role="columnheader" class="num">
            Cost<span class="unit">USD</span>
          </th>
        </tr>
      </thead>
      <tbody role="rowgroup">
        <For each={props.jobs}>
          {(job) => (
            <tr role="row">
              {/* A job's page comes later; until then its row leads nowhere. */}
              <td role="cell" class="is-id">
                <span class="cut mono" title={job.customId ?? job.id}>
                  {job.customId ?? job.id}
                </span>
              </td>
              <td role="cell" data-l="Status">
                <JobStatus job={job} />
              </td>
              <td role="cell" data-l="Batch">
                <Show when={job.batchId}>
                  {(batchId) => (
                    <span class="cut mono" title={batchId()}>
                      {batchId()}
                    </span>
                  )}
                </Show>
              </td>
              <td role="cell" data-l="Runner">
                <Show when={job.runner}>{(runner) => <RunnerOfJob runner={runner()} />}</Show>
              </td>
              <td role="cell" data-l="Time">
                <JobTime job={job} />
              </td>
              {/* A job that has not started has used nothing, which a blank says more quietly than
                  zeros. */}
              <td role="cell" class="num" data-l="Tokens">
                <Show when={job.startedAt}>{formatCount(job.usage.totalTokens)}</Show>
              </td>
              <td role="cell" class="num" data-l="Cost, USD">
                <Show when={job.startedAt}>{formatUsd(job.usage.cost.totalUsd)}</Show>
              </td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );
}

/** The Runner a job was last sent to, and whether it is connected. */
function RunnerOfJob(props: { runner: JobRunner }) {
  return (
    <span class="runner-ref">
      <span class="cut mono" title={props.runner.name}>
        {props.runner.name}
      </span>
      <span
        class={["mark", props.runner.connected ? "mark-connected" : "mark-disconnected"]}
        aria-hidden="true"
      />
      <span class="vh">{props.runner.connected ? "connected" : "not connected"}</span>
    </span>
  );
}

/** The latest of when the job was created, started and ended, and which it is. */
function JobTime(props: { job: ListedJob }) {
  const moment = (): [string, Date] => {
    const { createdAt, startedAt, endedAt } = props.job;
    if (endedAt) return ["ended", endedAt];
    if (startedAt) return ["started", startedAt];
    return ["created", createdAt];
  };
  return (
    <>
      {moment()[0]} <Instant value={moment()[1]} />
    </>
  );
}

/** The way to newer and older pages, where there are any. */
function Paging(props: { search: JobsSearch; page: JobsPage }) {
  const last = () => props.page.jobs.at(-1)?.id;
  return (
    <Show when={props.search.after !== undefined || props.page.hasMore}>
      <p class="list-end">
        <Show when={props.search.after !== undefined}>
          <Link to="/jobs" search={{ ...props.search, after: undefined }} class="stands-alone">
            Newest jobs
          </Link>
        </Show>
        <Show when={props.page.hasMore ? last() : undefined}>
          {(after) => (
            <Link to="/jobs" search={{ ...props.search, after: after() }} class="stands-alone">
              Older jobs
            </Link>
          )}
        </Show>
      </p>
    </Show>
  );
}

/**
 * What an empty list means, and what to do next: clear the filters that match nothing, or, on an
 * empty hub, connect a Runner first, then submit a Batch.
 */
function NoJobs(props: { search: JobsSearch; runners: UseQueryResult<Runner[]> }) {
  // A Runner list that could not be read says nothing of whether one is connected; the strip says
  // that it could not be read.
  const noneConnected = () =>
    !props.runners.isError && props.runners.data?.every((runner) => !runner.connected);
  return (
    <div class="empty">
      <Switch>
        <Match when={filterCount(props.search) > 0}>
          <h2>No job matches these filters</h2>
          <p class="empty-act">
            <Link to="/jobs" search={{}} class="stands-alone">
              Clear the filters
            </Link>
          </p>
        </Match>
        <Match when={props.search.after !== undefined}>
          <h2>No older jobs</h2>
          <p class="empty-act">
            <Link to="/jobs" search={{}} class="stands-alone">
              Newest jobs
            </Link>
          </p>
        </Match>
        <Match when={noneConnected()}>
          <h2>No jobs yet</h2>
          <p>Jobs run on Runners, and no Runner is connected to this hub.</p>
          <p class="empty-act">
            {/* The Runners page, at /runners: written through the route every address matches, as the
                router checks a link only against the routes it has. */}
            <Link to="/$" params={{ _splat: "runners" }} class="stands-alone">
              Add a Runner
            </Link>
          </p>
        </Match>
        <Match when={true}>
          <h2>No jobs yet</h2>
          <p>
            Submit a Batch of jobs with the CLI: <code>elflodge batches submit</code>
          </p>
        </Match>
      </Switch>
    </div>
  );
}

/** What could not be read, in the hub's words where it gave any, and the way to read it again. */
function ReadFailed(props: { error: Error | null; retry: () => void }) {
  return (
    <>
      <Notice role="alert">The jobs could not be read: {hubFailureMessage(props.error)}</Notice>
      <p>
        <button type="button" onClick={() => props.retry()}>
          Try again
        </button>
      </p>
    </>
  );
}
