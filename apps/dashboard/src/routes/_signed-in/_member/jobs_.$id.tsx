import { skipToken, useQuery } from "@tanstack/solid-query";
import { Link, createFileRoute, notFound, useLoaderData } from "@tanstack/solid-router";
import { jobRefSchema, problemOf, type Job } from "contract";
import {
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
  deep,
  latest,
  mapArray,
  onSettled,
} from "solid-js";

import { HubReadError, hubFailureDetail } from "../../../api-client.ts";
import { FailedReadNotice, ReadErrorPage } from "../../../components/FailedReadNotice.tsx";
import { FallbackPage } from "../../../components/FallbackPage.tsx";
import { Instant } from "../../../components/Instant.tsx";
import { JobActivity } from "../../../components/JobActivity.tsx";
import { JobControls } from "../../../components/JobControls.tsx";
import { JobFacts, JobLimits, JobOutputOrFailure } from "../../../components/JobRecord.tsx";
import { RunSentence } from "../../../components/JobRun.tsx";
import { JobTimeline } from "../../../components/JobTimeline.tsx";
import { RecordCrumbs } from "../../../components/RecordCrumbs.tsx";
import { focusIfLost } from "../../../form.ts";
import { TIME_ZONED, timeZoneNote } from "../../../format.ts";
import { readJobEvent } from "../../../job-event-record.ts";
import { useJobEvents } from "../../../job-events.ts";
import { groupJobEvents } from "../../../job-runs.ts";
import { memberPageHead } from "../../../page-title.ts";
import { REFRESH_INTERVAL_MS, orpc } from "../../../query.ts";
import { browserOnline, readIsFresh } from "../../../read-freshness.ts";

// UUIDs in addresses accept either case. The hub returns them in lowercase, including on a control.
function jobQuery(id: string) {
  return orpc.jobs.get.queryOptions({ input: { id: id.toLowerCase() } });
}

/** What names a job in its heading and title: its Custom ID unless blank, else its ID. */
function jobName(job: Pick<Job, "id" | "customId">) {
  return job.customId?.trim() ? job.customId : job.id;
}

export const Route = createFileRoute("/_signed-in/_member/jobs_/$id")({
  head: ({ match, params }) => {
    // The loader has warmed the cache the page reads. It holds no job for an account that is no
    // member and after a failed read, and then the address names the job.
    const job = match.context.queryClient.getQueryData(jobQuery(params.id).queryKey);
    const name =
      match.status === "notFound" ? "Job not found" : `Job ${job ? jobName(job) : params.id}`;
    return memberPageHead(match.context, name);
  },
  loader: async ({ context, params }) => {
    if (!context.member) return;
    if (!jobRefSchema.safeParse(params).success) throw notFound({ data: params.id });
    try {
      await context.queryClient.query({ ...jobQuery(params.id), staleTime: "static" });
    } catch (error) {
      if (problemOf(error)?.status === 404) throw notFound({ data: params.id });
      throw new HubReadError("The job", error);
    }
  },
  remountDeps: ({ params }) => params.id,
  pendingComponent: () => (
    <>
      <div class="head">
        <h1 class="subject">
          <span class="kind">Job</span>
          <span class="sk is-title" />
        </h1>
      </div>
      <div aria-busy="true">
        <span class="sk" />
        <span class="sk is-part" />
        <span class="sk is-short" />
      </div>
      <p class="vh" role="status">
        Loading the job
      </p>
    </>
  ),
  notFoundComponent: (props) => (
    <MissingJob id={typeof props.data === "string" ? props.data : ""} />
  ),
  errorComponent: (props) => <ReadErrorPage {...props} heading="Job" />,
  component: JobPage,
});

function MissingJob(props: { id: string; deleted?: boolean }) {
  let jobsLink: HTMLAnchorElement | undefined;
  onSettled(() => {
    if (props.deleted) focusIfLost(jobsLink);
  });
  return (
    <FallbackPage heading={props.deleted ? "This job was deleted" : "Job not found"}>
      <Show when={!props.deleted}>
        <p class="prose">
          No job with the ID <code class="job-address">{props.id}</code>.
        </p>
      </Show>
      <p class="prose">
        <Link
          to="/jobs"
          class="stands-alone"
          ref={(element) => {
            jobsLink = element;
          }}
        >
          Jobs
        </Link>
      </p>
    </FallbackPage>
  );
}

function JobPage() {
  const params = Route.useParams();
  const session = useLoaderData({ from: "/_signed-in" });
  const [deletedHere, setDeletedHere] = createSignal(false);
  const member = () => session().membership.status === "member";
  const jobEvents = useJobEvents(
    () => params().id.toLowerCase(),
    () => member() && !deletedHere(),
  );
  const read = useQuery(() => ({
    ...jobQuery(params().id),
    enabled: member() && jobEvents.needsJobRead(),
    refetchInterval: (query) =>
      problemOf(query.state.error)?.status === 404 ? false : REFRESH_INTERVAL_MS,
  }));
  const online = browserOnline();
  const fresh = readIsFresh(() => read.dataUpdatedAt);
  const waitingForRead = () => !fresh() || read.isPaused;
  const current = () => online() && !waitingForRead() && !read.isRefetchError;
  // A stalled poll must leave the last answer readable while its live indication expires, so
  // `deep` reads every field inside `latest`. A changed field, a Date included, gives its object a
  // new identity. Keeping it with a projection froze this page on a resume, so a child holding
  // focus, a title or a live region reads such a value directly.
  const job = createMemo(() => latest(() => deep(read.data)));
  const lastRecorded = () => !current() || !!job().statusUnknown;
  const running = () => job().status === "running" && !lastRecorded() && !job().deletedAt;
  const events = mapArray(jobEvents.events, readJobEvent, { keyed: true });
  const groups = createMemo(() => groupJobEvents(events(), jobEvents.firstHeadEventId()));
  const stopped = () => {
    const record = job();
    return (
      !record.deletedAt &&
      !record.pendingControl &&
      (record.status === "paused" || record.status === "failed" || record.status === "cancelled")
    );
  };
  const endedBeforeStart = () => job().status !== "paused" && !job().startedAt;
  const batch = useQuery(() => {
    const id = job().batchId;
    return orpc.batches.get.queryOptions({
      input: id && stopped() && !endedBeforeStart() ? { id } : skipToken,
      refetchInterval: REFRESH_INTERVAL_MS,
    });
  });
  const cannotResume = () => {
    if (!stopped()) return undefined;
    if (endedBeforeStart()) return "It ended before it started, so it cannot be resumed.";
    // Until the Batch read succeeds, offer Resume and let the hub explain any Batch refusal.
    const lastBatch = batch.dataUpdatedAt ? latest(() => batch.data) : undefined;
    if (lastBatch?.status === "cancelled")
      return "Its Batch was cancelled, so it cannot be resumed.";
    if (lastBatch?.pendingControl?.type === "cancel")
      return "Its Batch is being cancelled, so it cannot be resumed.";
    if (job().status !== "paused" && !job().runner)
      return "Its Runner was removed, so it cannot be resumed.";
    return undefined;
  };
  const resumeOffered = () => stopped() && !cannotResume();
  const output = createMemo(() => {
    const record = job();
    return record.status === "succeeded" && record.output !== undefined
      ? JSON.stringify(record.output, null, 2)
      : undefined;
  });
  const failure = () => {
    const record = job();
    return record.status === "failed" ? record.failure : undefined;
  };
  return (
    <Show
      when={!(read.isError && problemOf(read.error)?.status === 404)}
      fallback={<MissingJob id={params().id} deleted={deletedHere() || !!job().deletedAt} />}
    >
      <RecordCrumbs to="/jobs" batchId={job().batchId} />
      <div class="head">
        <h1 class="subject">
          <span class="kind">Job</span>
          <span class="whole-id">{jobName(job())}</span>
        </h1>
      </div>
      <Show
        when={
          !job().deletedAt &&
          (running() || job().status === "paused") &&
          jobEvents.isAtLatest() &&
          groups().sentenceRun
        }
      >
        <RunSentence run={groups().sentenceRun} status={job().status} />
      </Show>
      <p class="note">{timeZoneNote()}</p>
      <Switch>
        <Match when={!online()}>
          <p class="note is-unknown">
            This browser is offline. The job was last read at{" "}
            <Instant value={new Date(read.dataUpdatedAt)} format={TIME_ZONED} />.
          </p>
        </Match>
        <Match when={read.isRefetchError}>
          <FailedReadNotice
            what="The job"
            detail={hubFailureDetail(read.error)}
            failedAt={read.errorUpdatedAt}
            readAt={read.dataUpdatedAt}
          />
        </Match>
        <Match when={waitingForRead()}>
          <p class="note is-unknown">
            The job has not been read since{" "}
            <Instant value={new Date(read.dataUpdatedAt)} format={TIME_ZONED} />.
          </p>
        </Match>
      </Switch>
      <div class="record-with-aside">
        <div class="record-sections">
          <div>
            <JobControls
              job={job()}
              lastRecorded={lastRecorded()}
              cannotResume={cannotResume()}
              resumeOffered={resumeOffered()}
              deletedHere={deletedHere()}
              onDeleted={() => setDeletedHere(true)}
            />
          </div>
          <Show when={running()}>
            <JobActivity job={job()} />
          </Show>
          <Show when={!job().deletedAt || job().startedAt}>
            <JobLimits
              job={job()}
              resumeOffered={resumeOffered()}
              countFrom={running() && jobEvents.isAtLatest() ? groups().countFrom : undefined}
            />
          </Show>
          <Show when={output()} keyed>
            {(text) => <JobOutputOrFailure text={text} />}
          </Show>
          <Show when={failure()?.message} keyed>
            {(message) => <JobOutputOrFailure text={message} failure />}
          </Show>
        </div>
        <JobFacts job={job()} readAt={read.dataUpdatedAt} />
        <Show when={!job().deletedAt}>
          <JobTimeline job={job()} running={running()} events={jobEvents} groups={groups()} />
        </Show>
      </div>
    </Show>
  );
}
