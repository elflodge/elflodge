import { useQuery } from "@tanstack/solid-query";
import { Link, createFileRoute, notFound, useLoaderData } from "@tanstack/solid-router";
import { jobRefSchema, problemOf } from "contract";
import { Show, createMemo, createSignal, onSettled } from "solid-js";

import { HubReadError, hubFailureMessage } from "../../../api-client.ts";
import { FailedReadNotice, ReadErrorPage } from "../../../components/FailedReadNotice.tsx";
import { FallbackPage } from "../../../components/FallbackPage.tsx";
import { JobActivity } from "../../../components/JobActivity.tsx";
import { JobControls } from "../../../components/JobControls.tsx";
import { JobFacts, JobLimits, JobResult } from "../../../components/JobRecord.tsx";
import { ResumeGuidance } from "../../../components/JobStatus.tsx";
import { focusIfLost } from "../../../form.ts";
import { timeZoneNote } from "../../../format.ts";
import { REFRESH_INTERVAL_MS, orpc } from "../../../query.ts";

// UUIDs in addresses accept either case. The hub returns them in lowercase, including on a control.
function jobQuery(id: string) {
  return orpc.jobs.get.queryOptions({ input: { id: id.toLowerCase() } });
}

export const Route = createFileRoute("/_signed-in/_member/jobs_/$id")({
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
  return (
    <FallbackPage heading={props.deleted ? "This job was deleted." : "Job not found"}>
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
            if (props.deleted) onSettled(() => focusIfLost(element));
          }}
        >
          See the jobs
        </Link>
      </p>
    </FallbackPage>
  );
}

function JobPage() {
  const params = Route.useParams();
  const session = useLoaderData({ from: "/_signed-in" });
  const [deletedHere, setDeletedHere] = createSignal(false);
  const read = useQuery(() => ({
    ...jobQuery(params().id),
    enabled: session().membership.status === "member",
    refetchInterval: (query) =>
      problemOf(query.state.error)?.status === 404 ? false : REFRESH_INTERVAL_MS,
  }));
  const job = () => read.data;
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
      <div class="head">
        <h1 class="subject">
          <span class="kind">Job</span>
          {job().customId ?? job().id}
        </h1>
      </div>
      <p class="note">{timeZoneNote()}</p>
      <Show when={read.isError}>
        <FailedReadNotice
          what="The job"
          detail={hubFailureMessage(read.error)}
          failedAt={read.errorUpdatedAt}
          readAt={read.dataUpdatedAt}
        />
      </Show>
      <div class="job-layout">
        <div class="job-body">
          <div>
            <JobControls
              job={job()}
              deletedHere={deletedHere()}
              onDeleted={() => setDeletedHere(true)}
            />
          </div>
          <Show when={job().status === "running" && !job().statusUnknown && !job().deletedAt}>
            <JobActivity job={job()} readAt={read.dataUpdatedAt} />
          </Show>
          <JobLimits job={job()} />
          <Show when={output()}>{(text) => <JobResult text={text()} />}</Show>
          <Show when={failure()?.message}>
            {(message) => (
              <JobResult text={message()} failure>
                <ResumeGuidance job={job()} />
              </JobResult>
            )}
          </Show>
        </div>
        <JobFacts job={job()} readAt={read.dataUpdatedAt} />
      </div>
    </Show>
  );
}
