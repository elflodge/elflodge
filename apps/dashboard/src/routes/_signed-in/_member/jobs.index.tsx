import { useQuery } from "@tanstack/solid-query";
import { Link, createFileRoute } from "@tanstack/solid-router";
import type { JobsPage, ListedJob, Runner } from "contract";
import { For, Match, Repeat, Show, Switch, createMemo } from "solid-js";

import { hubFailureDetail, readFromHub } from "../../../api-client.ts";
import { FailedReadNotice, ReadErrorPage } from "../../../components/FailedReadNotice.tsx";
import { Instant } from "../../../components/Instant.tsx";
import { JobSubmitter, RunnerOfJob } from "../../../components/JobReferences.tsx";
import { BesideStatus, JobStatus } from "../../../components/JobStatus.tsx";
import {
  DAY,
  DAY_YEAR,
  LOCAL_ISO_DATE,
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
import {
  type JobsSearch,
  ClearFiltersLink,
  availableRunners,
  filterCount,
  jobsSearchSchema,
} from "./jobs.tsx";

export const Route = createFileRoute("/_signed-in/_member/jobs/")({
  // Both reads take only the declared filters and cursor, including after a sign-in redirect.
  loaderDeps: ({ search }) => jobsSearchSchema.parse(search),
  loader: async ({ context, deps }) => {
    if (!context.member) return;
    await readFromHub("The jobs", () =>
      context.queryClient.query(orpc.jobs.list.queryOptions({ input: deps, staleTime: "static" })),
    );
  },
  pendingComponent: LoadingList,
  errorComponent: (props) => {
    const search = Route.useLoaderDeps();
    return (
      <ReadErrorPage {...props} heading="Jobs">
        <Show when={filterCount(search()) > 0}>
          <p>
            <ClearFiltersLink>Clear the filters</ClearFiltersLink>
          </p>
        </Show>
      </ReadErrorPage>
    );
  },
  component: Jobs,
});

function Jobs() {
  const search = Route.useLoaderDeps();
  const jobs = useQuery(() =>
    orpc.jobs.list.queryOptions({ input: search(), refetchInterval: REFRESH_INTERVAL_MS }),
  );
  const runners = useQuery(() => orpc.runners.list.queryOptions());
  return (
    <>
      <Show when={jobs.isError || jobs.data.jobs.length}>
        <p class="note">{timeZoneNote()}</p>
      </Show>
      <Show when={jobs.isError}>
        <FailedReadNotice
          what="The jobs"
          detail={hubFailureDetail(jobs.error)}
          failedAt={jobs.errorUpdatedAt}
          readAt={jobs.dataUpdatedAt}
        />
      </Show>
      <Show
        when={jobs.data.jobs.length}
        fallback={
          <NoJobs
            search={search()}
            runners={runners.isError ? undefined : availableRunners(runners)}
          />
        }
      >
        <a class="vh skip-list" href="#jobs-end">
          Skip to the end of the list
        </a>
        <JobsTable
          jobs={jobs.data.jobs}
          runners={availableRunners(runners) ?? []}
          readAt={jobs.dataUpdatedAt}
        />
        <Paging search={search()} page={jobs.data} />
      </Show>
    </>
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
                    <time datetime={LOCAL_ISO_DATE.format(day())}>
                      {(day().getFullYear() === readDay().getFullYear() ? DAY : DAY_YEAR).format(
                        day(),
                      )}
                    </time>
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
        <JobStatus status={props.job.status} lastRecorded={!!props.job.statusUnknown} />
      </td>
      <td role="cell" class="c-beside">
        <BesideStatus job={props.job} />
      </td>
      <td role="cell" class="c-job">
        <span class="cell-line">
          <Link
            class="cut mono job-name"
            title={props.job.customId}
            to="/jobs/$id"
            params={{ id: props.job.id }}
          >
            {props.job.customId}
          </Link>
          <span class="sid" title={props.job.id}>
            {shortId()}
          </span>
        </span>
      </td>
      <td role="cell" class="c-batch">
        <Link
          to="/batches/$id"
          params={{ id: props.job.batchId }}
          class="cut mono stands-alone"
          title={props.job.batchId}
        >
          {props.job.batchId}
        </Link>
      </td>
      <td role="cell" class="c-submitter">
        <span class="cell-line">
          <JobSubmitter submitter={props.job.submitter} inList />
        </span>
      </td>
      <td role="cell" class="c-labels">
        <Labels labels={props.job.labels} />
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
          <span class="unit-inline"> USD, est.</span>
          <span class="of"> of {USD_BUDGET.format(props.job.modelBudgetUsd)}</span>
        </Show>
      </td>
    </tr>
  );
}

function Labels(props: { labels: ListedJob["labels"] }) {
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
        <Link
          activeOptions={{ exact: true }}
          to="/jobs"
          search={{ ...props.search, after: undefined }}
          class="stands-alone"
        >
          Newest jobs
        </Link>
      </Show>
      <Show when={props.page.hasMore ? last() : undefined}>
        {(after) => (
          <Link
            activeOptions={{ exact: true }}
            to="/jobs"
            search={{ ...props.search, after: after() }}
            class="stands-alone"
          >
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
function NoJobs(props: { search: JobsSearch; runners: Runner[] | undefined }) {
  const noneConnected = () => props.runners?.every((runner) => !runner.connected);
  return (
    <div class="empty">
      <Switch>
        <Match when={props.search.after !== undefined}>
          <h2>No older jobs</h2>
          <p class="empty-act">
            <Link
              activeOptions={{ exact: true }}
              to="/jobs"
              search={{ ...props.search, after: undefined }}
              class="stands-alone"
            >
              Newest jobs
            </Link>
          </p>
        </Match>
        <Match when={filterCount(props.search) > 0}>
          <h2>No job matches these filters</h2>
          <p class="empty-act">
            <ClearFiltersLink>Clear the filters</ClearFiltersLink>
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
