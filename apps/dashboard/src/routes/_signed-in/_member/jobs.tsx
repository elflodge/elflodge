import { useQuery } from "@tanstack/solid-query";
import type { UseQueryResult } from "@tanstack/solid-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/solid-router";
import { jobStatusSchema } from "contract";
import type { JobRunner, JobsPage, ListedJob, Runner } from "contract";
import { For, Loading, Match, Repeat, Show, Switch, createMemo, createSignal } from "solid-js";
import * as z from "zod/mini";

import { hubFailureMessage, readFromHub } from "../../../api-client.ts";
import { FailedReadNotice, ReadErrorPage } from "../../../components/FailedReadNotice.tsx";
import { Instant } from "../../../components/Instant.tsx";
import { BesideStatus, JobStatus, STATUS_WORDS } from "../../../components/JobStatus.tsx";
import { fieldText } from "../../../form.ts";
import {
  DAY,
  DAY_YEAR,
  DAY_TIME,
  TIME,
  USD_BUDGET,
  elapsedSince,
  formatCount,
  formatUsd,
  timeZoneNote,
} from "../../../format.ts";
import { orpc } from "../../../query.ts";
import { shortIds } from "../../../short-ids.ts";

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
    if (!context.member) return;
    await readFromHub("The jobs", () =>
      context.queryClient.query(
        orpc.jobs.list.queryOptions({ input: listInput(deps), staleTime: "static" }),
      ),
    );
  },
  // Shown while another page or other filters are read for longer than the router's wait, rather
  // than the list read before, under an address that no longer says what it shows.
  pendingComponent: Reading,
  errorComponent: (props) => {
    const search = Route.useSearch();
    return (
      <ReadErrorPage {...props} heading="Jobs">
        <Show when={filterCount(search()) > 0}>
          <p>
            <Link to="/jobs" search={{}} class="stands-alone">
              Clear the filters
            </Link>
          </p>
        </Show>
      </ReadErrorPage>
    );
  },
  component: Jobs,
});

/** The page while its list is read. */
function Reading() {
  const runners = useQuery(() => orpc.runners.list.queryOptions());
  return (
    <>
      <JobsHeader runners={runners.isSuccess ? runners.data : undefined} />
      <LoadingList />
    </>
  );
}

function JobsHeader(props: { runners?: Runner[] }) {
  const search = Route.useSearch();
  return (
    <>
      <div class="head">
        <h1>Jobs</h1>
      </div>
      <Filters search={search()} runners={props.runners} />
    </>
  );
}

function Jobs() {
  const search = Route.useSearch();
  const jobs = useQuery(() =>
    orpc.jobs.list.queryOptions({ input: listInput(search()), refetchInterval: REFRESH }),
  );
  const runners = useQuery(() => orpc.runners.list.queryOptions());
  return (
    <>
      <JobsHeader runners={runners.isSuccess ? runners.data : undefined} />
      <Loading fallback={<LoadingList />} on={search()}>
        <Show when={jobs.isError || jobs.data.jobs.length}>
          <p class="note">{timeZoneNote()}</p>
        </Show>
        <Show when={jobs.isError}>
          <FailedReadNotice
            what="The jobs"
            detail={hubFailureMessage(jobs.error)}
            failedAt={jobs.errorUpdatedAt}
            readAt={jobs.dataUpdatedAt}
          />
        </Show>
        <Show
          when={jobs.data.jobs.length}
          fallback={<NoJobs search={search()} runners={runners} />}
        >
          <a class="vh skip-list" href="#jobs-end">
            Skip to the end of the list
          </a>
          <JobsTable
            jobs={jobs.data.jobs}
            runners={runners.isSuccess ? runners.data : []}
            readAt={jobs.dataUpdatedAt}
          />
          <Paging search={search()} page={jobs.data} />
        </Show>
      </Loading>
    </>
  );
}

/** The filters, as one form that applies them all at once. */
function Filters(props: { search: JobsSearch; runners: Runner[] | undefined }) {
  const navigate = useNavigate();
  const applied = () => filterCount(props.search);

  const [open, setOpen] = createSignal(() => applied() > 0);

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
    <div class="filters">
      <button
        type="button"
        class="filter-toggle"
        aria-expanded={open() ? "true" : "false"}
        aria-controls="jobs-filters"
        onClick={() => setOpen(!open())}
      >
        Filters
        <Show when={applied() > 0}> ({formatCount(applied())} applied)</Show>
      </button>
      <form id="jobs-filters" class="filters-form" aria-label="Filter the jobs" onSubmit={apply}>
        <div class="filters-row">
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
        </div>
        <div class="filters-row">
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
        </div>
      </form>
    </div>
  );
}

const COLUMNS = [
  { cell: "c-status", heading: "Status" },
  { cell: "c-beside", heading: "Beside the status" },
  { cell: "c-job", heading: "Job" },
  { cell: "c-batch", heading: "Batch" },
  { cell: "c-submitter", heading: "Submitter" },
  { cell: "c-labels", heading: "Labels" },
  { cell: "c-runner", heading: "Runner" },
  { cell: "c-time", heading: "Time" },
  { cell: "c-tokens num", heading: "Tokens", unit: "so far" },
  { cell: "c-cost num", heading: "Cost of budget", unit: "so far, USD, est." },
];

function ListHead() {
  return (
    <thead role="rowgroup">
      <tr role="row">
        {COLUMNS.map(({ cell, heading, unit }) => (
          <th class={cell} scope="col" role="columnheader">
            {heading}
            <Show when={unit}>
              <span class="unit">{unit}</span>
            </Show>
          </th>
        ))}
      </tr>
    </thead>
  );
}

function LoadingList() {
  return (
    <>
      <div class="job-list-frame" aria-busy="true">
        <table class="job-list" aria-hidden="true">
          <ListHead />
          <tbody>
            <Repeat count={8}>
              {() => (
                <tr class="sk-row">
                  {COLUMNS.map(({ cell }) => (
                    <td class={cell}>{cell !== "c-beside" && <span class="sk" />}</td>
                  ))}
                </tr>
              )}
            </Repeat>
          </tbody>
        </table>
      </div>
      <p class="vh" role="status">
        Loading jobs
      </p>
    </>
  );
}

/** The page's creation days, in newest-first order, each followed by the jobs created that day. */
function JobsTable(props: { jobs: ListedJob[]; runners: Runner[]; readAt: number }) {
  const ids = createMemo(() =>
    shortIds([
      ...props.runners.map((runner) => runner.id),
      ...props.jobs.flatMap((job) => (job.runner ? [job.runner.id] : [])),
    ]),
  );
  const readDay = () => new Date(props.readAt);
  return (
    <div class="job-list-frame">
      <table class="job-list" role="table">
        <caption class="vh">Jobs</caption>
        <ListHead />
        <tbody role="rowgroup">
          <For each={props.jobs} keyed={(job) => job.id}>
            {(job, index) => (
              <>
                <Show
                  when={
                    props.jobs[index() - 1]?.createdAt.toDateString() !==
                    job().createdAt.toDateString()
                  }
                >
                  <tr class="day-line" role="row">
                    <th colspan={COLUMNS.length} scope="colgroup" role="rowheader">
                      Created{" "}
                      {job().createdAt.toDateString() === readDay().toDateString() && "today, "}
                      <Instant
                        value={job().createdAt}
                        format={
                          job().createdAt.getFullYear() === readDay().getFullYear() ? DAY : DAY_YEAR
                        }
                      />
                    </th>
                  </tr>
                </Show>
                <JobRow job={job()} runnerIds={ids()} readAt={props.readAt} />
              </>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

function JobRow(props: { job: ListedJob; runnerIds: Map<string, string>; readAt: number }) {
  // The tail distinguishes jobs created together, which share their UUIDv7 timestamp prefix.
  const shortId = () => `…${props.job.id.slice(-8)}`;
  return (
    <tr role="row" class={["job-row", { "is-deleted": !!props.job.deletedAt }]}>
      <td role="cell" class="c-status">
        <JobStatus job={props.job} />
      </td>
      <td role="cell" class="c-beside">
        <BesideStatus job={props.job} />
      </td>
      <td role="cell" class="c-job">
        <span class="cell-line">
          <Show
            when={props.job.customId}
            fallback={
              <span class="cut sid job-name" title={props.job.id}>
                {shortId()}
              </span>
            }
          >
            {(name) => (
              <>
                <span class="cut mono job-name" title={name()}>
                  {name()}
                </span>
                <span class="sid" title={props.job.id}>
                  {shortId()}
                </span>
              </>
            )}
          </Show>
        </span>
      </td>
      <td role="cell" class="c-batch">
        <span class="cut mono" title={props.job.batchId}>
          {props.job.batchId}
        </span>
      </td>
      <td role="cell" class="c-submitter">
        <Show when={props.job.submitter}>
          {(submitter) => (
            <span class="cell-line">
              <span
                class={[
                  "cut",
                  {
                    mono: submitter().kind === "key",
                    unnamed: submitter().kind === "key" && submitter().name === null,
                  },
                ]}
                title={submitter().name ?? "Unnamed"}
              >
                {submitter().name ?? "Unnamed"}
              </span>
              <span class="unit">{submitter().kind}</span>
            </span>
          )}
        </Show>
      </td>
      <td role="cell" class="c-labels">
        <Show when={props.job.labels}>{(labels) => <Labels labels={labels()} />}</Show>
      </td>
      <td role="cell" class="c-runner">
        <Show when={props.job.runner}>
          {(runner) => (
            <RunnerOfJob
              runner={runner()}
              shortId={props.runnerIds.get(runner().id) ?? runner().id}
            />
          )}
        </Show>
      </td>
      <td role="cell" class="c-time">
        <JobTime job={props.job} readAt={props.readAt} />
      </td>
      <td role="cell" class="c-tokens num">
        <Show when={props.job.startedAt}>{formatCount(props.job.usage.totalTokens)}</Show>
      </td>
      <td role="cell" class="c-cost num">
        <Show when={props.job.startedAt}>
          {formatUsd(props.job.usage.cost.totalUsd)}
          <span class="unit-inline"> USD</span>
          <Show when={props.job.modelBudgetUsd}>
            {(budget) => <span class="of"> of {USD_BUDGET.format(budget())}</span>}
          </Show>
        </Show>
      </td>
    </tr>
  );
}

function Labels(props: { labels: NonNullable<ListedJob["labels"]> }) {
  const entries = createMemo(() => Object.entries(props.labels));
  // The Labels column has 112px for text. Reserve the count and its gap only if more follow.
  const count = createMemo(() => {
    let width = 0;
    let withCount = 1;
    for (const [index, [key, value]] of entries().entries()) {
      width += (index ? 8 : 0) + 7 * (key.length + 1 + value.length);
      if (width > 112) return withCount;
      if (width + 32 <= 112) withCount = index + 1;
    }
    return entries().length;
  });
  return (
    <ul class="labels is-line">
      <For each={entries().slice(0, count())}>
        {([key, value]) => (
          <li>
            <span class="cut" title={`${key}=${value}`}>
              <span class="lk">{key}</span>
              <span class="leq">=</span>
              {value}
            </span>
          </li>
        )}
      </For>
      <Show when={count() < entries().length}>
        <li
          class="labels-more"
          title={entries()
            .map(([key, value]) => `${key}=${value}`)
            .join(", ")}
        >
          +{entries().length - count()}
          <span class="vh"> more Labels</span>
        </li>
      </Show>
    </ul>
  );
}

/** The Runner a job was last sent to, and whether it is connected. */
function RunnerOfJob(props: { runner: JobRunner; shortId: string }) {
  return (
    <span class="runner-ref">
      <span class="cut mono" title={props.runner.name}>
        {props.runner.name}
      </span>
      <span class="sid" title={props.runner.id}>
        {props.shortId}
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
function JobTime(props: { job: ListedJob; readAt: number }) {
  const moment = (): [string, Date] => {
    const { createdAt, startedAt, endedAt } = props.job;
    if (endedAt) return ["ended", endedAt];
    if (startedAt) return ["started", startedAt];
    return ["created", createdAt];
  };
  const sameDay = () => moment()[1].toDateString() === props.job.createdAt.toDateString();
  return (
    <>
      {moment()[0]} <Instant value={moment()[1]} format={sameDay() ? TIME : DAY_TIME} />
      <Show when={sameDay() && !props.job.endedAt}>
        <span class="age">, {elapsedSince(moment()[1], props.readAt)}</span>
      </Show>
    </>
  );
}

/** The way to newer and older pages, where there are any. */
function Paging(props: { search: JobsSearch; page: JobsPage }) {
  const last = () => props.page.jobs.at(-1)?.id;
  return (
    <p class="list-end" id="jobs-end" tabindex="-1">
      <span>
        {formatCount(props.page.jobs.length)} read;{" "}
        {props.page.hasMore
          ? "the hub gives no total."
          : filterCount(props.search)
            ? "no more match."
            : "there are no older jobs."}
      </span>
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
            <Link to="/runners" class="stands-alone">
              Add Runner
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
