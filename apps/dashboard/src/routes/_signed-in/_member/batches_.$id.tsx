import { skipToken, useQuery } from "@tanstack/solid-query";
import { Link, createFileRoute, notFound, useLoaderData } from "@tanstack/solid-router";
import { batchRefSchema, jobStatusSchema, problemOf, type Batch } from "contract";
import { For, Show } from "solid-js";

import { HubReadError, hubFailureMessage } from "../../../api-client.ts";
import { totalJobs } from "../../../batch.ts";
import { BatchControls } from "../../../components/BatchControls.tsx";
import { FailedReadNotice, ReadErrorPage } from "../../../components/FailedReadNotice.tsx";
import { FallbackPage } from "../../../components/FallbackPage.tsx";
import { Instant } from "../../../components/Instant.tsx";
import { JobSubmitter } from "../../../components/JobReferences.tsx";
import { STATUS_WORDS } from "../../../components/JobStatus.tsx";
import { RecordCrumbs } from "../../../components/RecordCrumbs.tsx";
import { DATE_TIME_SECONDS, formatCount, formatUsd, timeZoneNote } from "../../../format.ts";
import { orpc, REFRESH_INTERVAL_MS } from "../../../query.ts";

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
      <RecordCrumbs parent="Batches" />
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
      <p>
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
      refetchInterval: (query) =>
        problemOf(query.state.error)?.status === 404 ? false : REFRESH_INTERVAL_MS,
    }),
  );
  const batch = () => read.data;
  const missing = () => problemOf(read.error)?.status === 404;
  // As in CLI progress, the newest queued job tells whether the Canary holds the rest.
  // A Batch read carrying its Canary condition would replace this read.
  const queued = useQuery(() =>
    orpc.jobs.list.queryOptions({
      input:
        session().membership.status === "member" &&
        !missing() &&
        batch().breaker &&
        batch().jobCounts.queued > 0
          ? { batchId: batch().id, status: ["queued"], limit: 1 }
          : skipToken,
      refetchInterval: REFRESH_INTERVAL_MS,
    }),
  );
  return (
    <Show when={!missing()} fallback={<MissingBatch id={params().id} />}>
      <RecordCrumbs parent="Batches" />
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
          detail={hubFailureMessage(read.error)}
          failedAt={read.errorUpdatedAt}
          readAt={read.dataUpdatedAt}
        />
      </Show>
      <div class="record-with-aside">
        <div class="record-sections">
          <div>
            <BatchControls
              batch={batch()}
              canary={
                batch().status === "active" &&
                !batch().pendingControl &&
                !!queued.dataUpdatedAt &&
                queued.data.jobs[0]?.blockedBy === "batchCanary"
              }
            />
            <Show when={queued.isError}>
              <FailedReadNotice
                what="The Canary condition"
                detail={hubFailureMessage(queued.error)}
                failedAt={queued.errorUpdatedAt}
                readAt={queued.dataUpdatedAt}
              />
            </Show>
          </div>
          <BatchJobs batch={batch()} />
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
    </Show>
  );
}

function BatchJobs(props: { batch: Batch }) {
  const total = () => totalJobs(props.batch.jobCounts);
  // Unknown jobs keep their last recorded status. The Batch gives one unknown count across statuses.
  const knownRunning = () => props.batch.jobCounts.running > props.batch.statusUnknownJobs;
  return (
    <section aria-labelledby="batch-jobs">
      <h2 id="batch-jobs">Its jobs</h2>
      <Show when={total()} fallback={<p>It has no jobs.</p>}>
        <table class="ledger">
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
              <tr>
                <th scope="row">
                  <span
                    class={[
                      "status-word",
                      (status !== "running" || knownRunning()) && `s-${status}`,
                    ]}
                  >
                    <span class={["mark", `mark-${status}`]} aria-hidden="true" />
                    {STATUS_WORDS[status]}
                  </span>
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
        <Show when={props.batch.statusUnknownJobs}>
          {(n) => (
            <p class="note is-unknown">
              <span class="mark mark-unknown" aria-hidden="true" /> {formatCount(n())} of these{" "}
              {n() === 1 ? "has" : "have"} status unknown: each is counted under its last recorded
              status.{" "}
              <Link to="/jobs" search={{ batchId: props.batch.id, statusUnknown: true }}>
                See them<span class="vh">: its jobs with status unknown</span>
              </Link>
            </p>
          )}
        </Show>
      </Show>
    </section>
  );
}

function breakerSettings(breaker: Batch["breaker"]) {
  if (!breaker) return "Off";
  const canary = `Canary of ${formatCount(breaker.canary)} ${breaker.canary === 1 ? "job" : "jobs"}`;
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
          <dt>Labels for every job</dt>
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
