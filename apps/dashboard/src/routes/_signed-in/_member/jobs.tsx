import { useQuery } from "@tanstack/solid-query";
import type { UseQueryResult } from "@tanstack/solid-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/solid-router";
import { BATCH_ID_PATTERN, jobStatusSchema } from "contract";
import type { JobRunner, JobsPage, ListedJob, Runner } from "contract";
import { For, Loading, Match, Repeat, Show, Switch, createMemo, createSignal } from "solid-js";
import * as z from "zod/mini";

import { hubFailureMessage, readFromHub } from "../../../api-client.ts";
import { FailedReadNotice, ReadErrorPage } from "../../../components/FailedReadNotice.tsx";
import { Instant } from "../../../components/Instant.tsx";
import { BesideStatus, JobStatus, STATUS_WORDS } from "../../../components/JobStatus.tsx";
import { createFormAction, fieldText } from "../../../form.ts";
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
import { REFRESH_INTERVAL_MS, orpc } from "../../../query.ts";
import { shortIds } from "../../../short-ids.ts";

const STATUSES = jobStatusSchema.options;
const optionalText = z.catch(z.optional(z.string().check(z.minLength(1))), undefined);

/**
 * The list's filters and its page, held in the address so that a link or a reload keeps them. A
 * value the list cannot take is dropped, and the filters' form then shows what is applied; one the
 * hub refuses, such as a Batch ID it does not allow, is the hub's to name when the list is read.
 */
const jobsSearchSchema = z.object({
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
  after: optionalText,
});
type JobsSearch = z.infer<typeof jobsSearchSchema>;

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
      context.queryClient.query(orpc.jobs.list.queryOptions({ input: deps, staleTime: "static" })),
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
      <JobsHeader reading runners={runners.dataUpdatedAt ? runners.data : undefined} />
      <LoadingList />
    </>
  );
}

function JobsHeader(props: { reading?: boolean; runners?: Runner[] }) {
  const search = Route.useSearch();
  return (
    <>
      <div class="head">
        <h1>Jobs</h1>
      </div>
      <Filters reading={props.reading} search={search()} runners={props.runners} />
    </>
  );
}

function Jobs() {
  const search = Route.useSearch();
  const jobs = useQuery(() =>
    orpc.jobs.list.queryOptions({ input: search(), refetchInterval: REFRESH_INTERVAL_MS }),
  );
  const runners = useQuery(() => orpc.runners.list.queryOptions());
  return (
    <>
      <JobsHeader runners={runners.dataUpdatedAt ? runners.data : undefined} />
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
            runners={runners.dataUpdatedAt ? runners.data : []}
            readAt={jobs.dataUpdatedAt}
          />
          <Paging search={search()} page={jobs.data} />
        </Show>
      </Loading>
    </>
  );
}

/** The filters, as one form that applies them all at once. */
function Filters(props: { reading?: boolean; search: JobsSearch; runners: Runner[] | undefined }) {
  const navigate = useNavigate();
  const applied = () => filterCount(props.search);

  const [open, setOpen] = createSignal(() => applied() > 0);

  const { pending, onSubmit } = createFormAction((element) => {
    const form = new FormData(element);
    const chosen = form.getAll("status");
    const batchId = fieldText(form, "batchId").trim();
    const runnerId = fieldText(form, "runnerId");
    const status = STATUSES.filter((value) => chosen.includes(value));
    return navigate({
      to: "/jobs",
      search: {
        status: status.length > 0 ? status : undefined,
        statusUnknown: fieldText(form, "statusUnknown") || undefined,
        batchId: batchId || undefined,
        runnerId: runnerId || undefined,
      },
    });
  });

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
      <form id="jobs-filters" class="filters-form" aria-label="Filter the jobs" onSubmit={onSubmit}>
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
            <input
              id="jobs-batch"
              name="batchId"
              pattern={BATCH_ID_PATTERN.source}
              title="Use letters, digits, underscores or hyphens. Start with a letter, digit or underscore."
              value={props.search.batchId ?? ""}
            />
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
            <button
              id="jobs-apply"
              type="submit"
              class="primary"
              disabled={props.reading || pending()}
            >
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
  const days = createMemo(() =>
    Array.from(Map.groupBy(props.jobs, (job) => new Date(job.createdAt).setHours(0, 0, 0, 0))),
  );
  const readDay = () => new Date(props.readAt);
  return (
    <div class="job-list-frame">
      <table class="job-list" role="table">
        <caption class="vh">Jobs</caption>
        <ListHead />
        <For each={days()} keyed={([day]) => day}>
          {(group) => {
            const day = () => new Date(group()[0]);
            return (
              <tbody role="rowgroup">
                <tr class="day-line" role="row">
                  <th colspan={COLUMNS.length} scope="rowgroup" role="rowheader">
                    Created {day().toDateString() === readDay().toDateString() && "today, "}
                    <Instant
                      value={day()}
                      format={day().getFullYear() === readDay().getFullYear() ? DAY : DAY_YEAR}
                    />
                  </th>
                </tr>
                <For each={group()[1]} keyed={(job) => job.id}>
                  {(job) => <JobRow job={job()} runnerIds={ids()} readAt={props.readAt} />}
                </For>
              </tbody>
            );
          }}
        </For>
      </table>
    </div>
  );
}

function JobRow(props: { job: ListedJob; runnerIds: Map<string, string>; readAt: number }) {
  // The tail distinguishes jobs created together, which share their UUIDv7 timestamp prefix.
  const shortId = () => `…${props.job.id.slice(-8)}`;
  return (
    <tr role="row" class="job-row">
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
  return (
    <ul class="labels is-line">
      <Show when={entries()[0]} keyed>
        {([key, value]) => (
          <li>
            <span class="cut" title={`${key}=${value}`}>
              <span class="lk">{key}</span>
              <span class="leq">=</span>
              {value}
            </span>
          </li>
        )}
      </Show>
      <Show when={entries().length > 1}>
        <li
          class="labels-more"
          title={entries()
            .map(([key, value]) => `${key}=${value}`)
            .join(", ")}
        >
          +{entries().length - 1}
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
        <Match when={props.search.after !== undefined}>
          <h2>No older jobs</h2>
          <p class="empty-act">
            <Link to="/jobs" search={{ ...props.search, after: undefined }} class="stands-alone">
              Newest jobs
            </Link>
          </p>
        </Match>
        <Match when={filterCount(props.search) > 0}>
          <h2>No job matches these filters</h2>
          <p class="empty-act">
            <Link to="/jobs" search={{}} class="stands-alone">
              Clear the filters
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
