import { useQuery } from "@tanstack/solid-query";
import { Link, createFileRoute, notFound, useLoaderData } from "@tanstack/solid-router";
import { batchRefSchema, jobStatusSchema, problemOf, type Batch } from "contract";
import { For, Show, createMemo, deep, latest } from "solid-js";

import { HubReadError, hubFailureDetail } from "../../../api-client.ts";
import { totalJobs } from "../../../batch.ts";
import { BatchControls } from "../../../components/BatchControls.tsx";
import { FailedReadNotice, ReadErrorPage } from "../../../components/FailedReadNotice.tsx";
import { FallbackPage } from "../../../components/FallbackPage.tsx";
import { Instant } from "../../../components/Instant.tsx";
import { JobSubmitter } from "../../../components/JobReferences.tsx";
import { JobStatus } from "../../../components/JobStatus.tsx";
import { RecordCrumbs } from "../../../components/RecordCrumbs.tsx";
import {
  DATE_TIME_SECONDS,
  formatCount,
  formatUsd,
  plural,
  timeZoneNote,
} from "../../../format.ts";
import { orpc, REFRESH_INTERVAL_MS } from "../../../query.ts";
import { browserOnline, readIsFresh } from "../../../read-freshness.ts";

export const Route = createFileRoute("/_signed-in/_member/batches_/$id")({
  loader: async ({ context, params }) => {
    if (!context.member) return;
    if (!batchRefSchema.safeParse(params).success) throw notFound({ data: params.id });
    try {
      await context.queryClient.query(
        orpc.batches.get.queryOptions({ input: params, staleTime: "static" }),
      );
    } catch (error) {
      if (problemOf(error)?.status === 404) throw notFound({ data: params.id });
      throw new HubReadError("The Batch", error);
    }
  },
  remountDeps: ({ params }) => params.id,
  pendingComponent: () => (
    <>
      <RecordCrumbs to="/batches" />
      <div class="head">
        <h1 class="subject">
          <span class="kind">Batch</span>
          <span class="sk is-title" />
        </h1>
      </div>
      <div aria-busy="true">
        <span class="sk" />
        <span class="sk is-part" />
        <span class="sk is-short" />
      </div>
      <p class="vh" role="status">
        Loading the Batch
      </p>
    </>
  ),
  notFoundComponent: (props) => (
    <MissingBatch id={typeof props.data === "string" ? props.data : ""} />
  ),
  errorComponent: (props) => <ReadErrorPage {...props} heading="Batch" />,
  component: BatchPage,
});

function MissingBatch(props: { id: string }) {
  return (
    <FallbackPage heading="Batch not found">
      <p class="prose">
        No Batch with the ID <code class="job-address">{props.id}</code>. IDs are compared exactly,
        capitals included.
      </p>
      <p class="prose">
        <Link to="/batches" class="stands-alone">
          Batches
        </Link>
      </p>
    </FallbackPage>
  );
}

function BatchPage() {
  const params = Route.useParams();
  const session = useLoaderData({ from: "/_signed-in" });
  const read = useQuery(() =>
    orpc.batches.get.queryOptions({
      input: { id: params().id },
      enabled: session().membership.status === "member",
      refetchInterval: REFRESH_INTERVAL_MS,
    }),
  );
  // To keep the ledger readable and let its live indication expire while a poll is held, `deep`
  // reads every field inside `latest`. A changed field gives its object a new identity, as on the
  // job page.
  const batch = createMemo(() => latest(() => deep(read.data)));
  const online = browserOnline();
  const fresh = readIsFresh(() => read.dataUpdatedAt);
  const current = () => online() && fresh() && !read.isPaused && !read.isRefetchError;
  return (
    <>
      <RecordCrumbs to="/batches" />
      <div class="head">
        <h1 class="subject">
          <span class="kind">Batch</span>
          {batch().id}
        </h1>
      </div>
      <p class="note">{timeZoneNote()}</p>
      <Show when={read.isError}>
        <FailedReadNotice
          what="The Batch"
          detail={hubFailureDetail(read.error)}
          failedAt={read.errorUpdatedAt}
          readAt={read.dataUpdatedAt}
        />
      </Show>
      <div class="record-with-aside">
        <div class="record-sections">
          <div>
            <BatchControls batch={batch()} />
          </div>
          <BatchJobs batch={batch()} current={current()} />
          <Show when={batch().usage.totalTokens > 0}>
            <section aria-labelledby="batch-usage">
              <h2 id="batch-usage">Usage</h2>
              <dl>
                <dt>Cost{batch().status !== "cancelled" && " so far"}</dt>
                <dd>
                  {formatUsd(batch().usage.cost.totalUsd)} <span class="unit">USD, est.</span>
                </dd>
                <dt>Tokens{batch().status !== "cancelled" && " so far"}</dt>
                <dd>{formatCount(batch().usage.totalTokens)}</dd>
              </dl>
              <p class="note">Counts its present jobs, running included.</p>
            </section>
          </Show>
        </div>
        <BatchFacts batch={batch()} />
      </div>
    </>
  );
}

function BatchJobs(props: { batch: Batch; current: boolean }) {
  const total = () => totalJobs(props.batch.jobCounts);
  // Unknown jobs keep their last recorded status. The Batch gives one unknown count across statuses.
  const runningLastRecorded = () => !props.current || props.batch.statusUnknownJobs > 0;
  return (
    <section aria-labelledby="batch-jobs">
      <h2 id="batch-jobs">Its jobs</h2>
      <Show when={total()} fallback={<p>It has no jobs.</p>}>
        <table class="ledger by-share">
          <caption class="vh">Jobs by status</caption>
          <thead>
            <tr>
              <th scope="col">Status</th>
              <th scope="col" class="num">
                Jobs
              </th>
              <th scope="col">Share</th>
              <th scope="col">
                <span class="vh">Jobs list</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {jobStatusSchema.options.map((status) => (
              <tr class={{ "is-zero": props.batch.jobCounts[status] === 0 }}>
                <th scope="row">
                  <JobStatus
                    status={status}
                    lastRecorded={status === "running" && runningLastRecorded()}
                  />
                </th>
                <td class="num">{formatCount(props.batch.jobCounts[status])}</td>
                <td>
                  <meter
                    min={0}
                    max={total()}
                    value={props.batch.jobCounts[status]}
                    aria-label={`Share of ${status} jobs`}
                    aria-valuetext={`${formatCount(props.batch.jobCounts[status])} of ${formatCount(total())} jobs`}
                  />
                </td>
                <td>
                  <Show when={props.batch.jobCounts[status]}>
                    <Link
                      class="stands-alone"
                      to="/jobs"
                      search={{ batchId: props.batch.id, status: [status] }}
                    >
                      See them<span class="vh">: its {status} jobs</span>
                    </Link>
                  </Show>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">
                <Link class="stands-alone" to="/jobs" search={{ batchId: props.batch.id }}>
                  All its jobs
                </Link>
              </th>
              <td class="num">{formatCount(total())}</td>
              <td colspan={2} />
            </tr>
          </tfoot>
        </table>
        {/* Read directly: the count changes while its link may hold the focus. */}
        <Show when={props.batch.statusUnknownJobs}>
          <p class="note is-unknown">
            <span class="mark mark-unknown" aria-hidden="true" />{" "}
            {formatCount(props.batch.statusUnknownJobs)} of these{" "}
            {plural(props.batch.statusUnknownJobs, "has", "have")} status unknown: each is counted
            under its last recorded status.{" "}
            <Link to="/jobs" search={{ batchId: props.batch.id, statusUnknown: true }}>
              See them<span class="vh">: its jobs with status unknown</span>
            </Link>
          </p>
        </Show>
      </Show>
    </section>
  );
}

function breakerSettings(breaker: Batch["breaker"]) {
  if (!breaker) return "Off";
  const canary = `Canary of ${formatCount(breaker.canary)} ${plural(breaker.canary, "job", "jobs")}`;
  if (breaker.canary && breaker.maxFailurePercent === 100) return canary + " only";
  return `${breaker.canary ? canary + ", then" : "No Canary;"} at most ${breaker.maxFailurePercent}% failed`;
}

function BatchFacts(props: { batch: Batch }) {
  return (
    <aside class="facts-aside" aria-labelledby="batch-facts">
      <h2 id="batch-facts">The Batch</h2>
      <dl>
        <dt>ID</dt>
        <dd class="mono selectable">{props.batch.id}</dd>
        <dt>Created</dt>
        <dd>
          <Instant value={props.batch.createdAt} format={DATE_TIME_SECONDS} />
        </dd>
        <dt>Created by</dt>
        <dd>
          <JobSubmitter submitter={props.batch.submitter} />
        </dd>
        <Show when={Object.keys(props.batch.labels).length}>
          <dt>Labels</dt>
          <dd>
            <ul class="labels">
              <For each={Object.entries(props.batch.labels)}>
                {(entry) => (
                  <li>
                    <span class="lk">{entry[0]}</span>
                    <span class="leq">=</span>
                    {entry[1]}
                  </li>
                )}
              </For>
            </ul>
          </dd>
        </Show>
        <dt>Failure breaker</dt>
        <dd>{breakerSettings(props.batch.breaker)}</dd>
      </dl>
    </aside>
  );
}
