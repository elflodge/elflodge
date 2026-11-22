import { useMutation, useQueryClient } from "@tanstack/solid-query";
import { Link, createFileRoute, useRouter } from "@tanstack/solid-router";
import { BATCH_ID_PATTERN, MAX_BATCH_ID_LENGTH, batchCreationSchema } from "contract";
import { Show, createSignal } from "solid-js";

import {
  AgentFields,
  agentControls,
  agentFields,
  agentOf,
} from "../../../components/AgentFields.tsx";
import {
  EarlierWords,
  LeaveDialog,
  createDraftSubmission,
} from "../../../components/DraftSubmission.tsx";
import { Field } from "../../../components/Field.tsx";
import { LabelFields, isEndedAtLabelCount, labelsOf } from "../../../components/LabelFields.tsx";
import { Notice } from "../../../components/Notice.tsx";
import { RecordCrumbs } from "../../../components/RecordCrumbs.tsx";
import {
  createFormAction,
  fieldText,
  formRefusal,
  issuesRefusal,
  withoutRefusals,
} from "../../../form.ts";
import { preloadJobLimits } from "../../../job-limits.ts";
import { memberPageHead } from "../../../page-title.ts";
import { orpc } from "../../../query.ts";

// Under /jobs/, where the bar marks Jobs: job IDs are UUIDs, so "new" cannot name a job.
export const Route = createFileRoute("/_signed-in/_member/jobs_/new")({
  head: ({ match }) => memberPageHead(match.context, "Submit a job"),
  loader: ({ context }) => preloadJobLimits(context),
  component: SubmitJob,
});

// The two IDs name the same submission. Other locators have no control and stay in the form alert.
const controls = {
  id: ["id", "jobs[0][customId]"],
  input: ["jobs[0][input]"],
  ...agentControls,
};

function isTextControl(control: unknown) {
  return control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement;
}

function SubmitJob() {
  const router = useRouter();
  const client = useQueryClient();
  const [failure, setFailure] = createSignal<ReturnType<typeof formRefusal>>();
  let formElement: HTMLFormElement | undefined;
  const submission = createDraftSubmission(() => formElement);
  // The request can be up to 16 MiB; the page reads the answer from `mutate`, so the cache need not keep it.
  const create = useMutation(() => orpc.batches.create.mutationOptions({ gcTime: 0 }));

  const { pending, onSubmit } = createFormAction(async (form) => {
    submission.sending();
    const data = new FormData(form);
    const { agent, schemaRefusal } = agentOf(form, data);
    if (schemaRefusal) {
      setFailure({
        fields: new Map([[agentFields.outputSchema, schemaRefusal]]),
        alert: undefined,
      });
      return;
    }
    const labels = labelsOf(data);
    const placed = { ...controls, ...labels.controls };
    const id = submission.takeId(fieldText(data, "id"));
    // Checked here, not by oRPC's RequestValidationPlugin, which would check every dashboard call:
    // the schema's text is parsed first, and the page must know whether anything was sent.
    const checked = batchCreationSchema.safeParse({
      id,
      // As `jobs submit` sends it: a breaker means nothing for one job, which would be its Canary,
      // and would pause the Batch if that job failed. A repeat under the same ID, from the CLI or
      // this page, matches while both send this.
      breaker: false,
      labels: labels.labels,
      jobs: [{ customId: id, input: fieldText(data, "input") }],
      agent,
    });
    if (!checked.success) {
      setFailure(issuesRefusal(checked.error.issues, placed));
      return;
    }
    submission.creating();
    try {
      const result = await create.mutate(checked.data);
      const first = result.jobs[0];
      if (!first) throw new Error("The hub answered without the submitted job.");
      // The answer names the job by its IDs; the job's page reads the job itself.
      const job = first.job;
      void client.invalidateQueries({ queryKey: orpc.jobs.list.key() });
      void client.invalidateQueries({ queryKey: orpc.jobs.counts.key() });
      void client.invalidateQueries({ queryKey: orpc.batches.list.key() });
      void client.invalidateQueries({ queryKey: orpc.batches.get.queryKey({ input: { id } }) });
      if (submission.markSucceeded(id)) {
        // A repeat names a job the member may have opened before, and its page's loader takes a
        // cached copy of any age, so the copy goes and the job is read as it stands now. Only here:
        // a member who left may already be reading that page.
        client.removeQueries({
          queryKey: orpc.jobs.get.queryKey({ input: { id: job.id } }),
          exact: true,
        });
        await router.navigate({ to: "/jobs/$id", params: { id: job.id } });
      } else setFailure(undefined);
    } catch (error) {
      submission.markFailed(error, id);
      setFailure(formRefusal(error, placed));
    }
  });

  // The previous refusal belongs to the last attempt while the next request is pending.
  const displayedFailure = () => (pending() ? undefined : failure());
  const refused = (name: string) => displayedFailure()?.fields.get(name);
  // The hub's words, then what the member can do about an earlier send whose outcome is unknown.
  const hubWords = () => (pending() ? undefined : failure()?.alert);
  const earlier = () => (pending() ? undefined : submission.earlier());

  return (
    <>
      <RecordCrumbs to="/jobs" />
      <div class="head">
        <h1>Submit a job</h1>
      </div>
      <form
        class="fields is-wide"
        ref={(form) => {
          formElement = form;
        }}
        autocomplete="off"
        onSubmit={onSubmit}
        onInput={(event) => {
          const control = event.target;
          if (!isTextControl(control)) return;
          if (control.name === "id") submission.idEdited(control.value);
          setFailure(
            (previous) => previous && withoutRefusals(previous, (name) => name === control.name),
          );
        }}
      >
        <p class="note">
          This submits one job from typed text, as a Batch of one. To give jobs files, or to submit
          several, use <Link to="/batches/-/new">Submit a Batch</Link>.
        </p>
        <AgentFields
          of="job"
          pending={pending()}
          refused={refused}
          afterInstructions={
            <Field label="Input" hint="What the agent works on." error={refused("input")}>
              {(control) => (
                <textarea
                  {...control}
                  name="input"
                  // Eight rows: a short document, such as an invoice's lines and a question about them.
                  rows={8}
                  required
                  readonly={pending()}
                />
              )}
            </Field>
          }
          afterSchema={
            <Field
              label="Custom ID"
              hint={
                <>
                  Optional. Names the job and its Batch of one: 1 to {MAX_BATCH_ID_LENGTH} letters,
                  digits, <code>_</code> and <code>-</code>, not beginning with <code>-</code>. Left
                  empty, one is made.
                </>
              }
              error={refused("id")}
            >
              {(control) => (
                <input
                  {...control}
                  name="id"
                  pattern={BATCH_ID_PATTERN.source}
                  title="Letters, digits, _ and -, not beginning with -"
                  spellcheck={false}
                  autocapitalize="off"
                  readonly={pending()}
                />
              )}
            </Field>
          }
        />
        <LabelFields
          hint="Optional. The job carries them, and Usage can group cost by a key."
          pending={pending()}
          refused={refused}
          onChange={(count) => {
            setFailure(
              (previous) => previous && withoutRefusals(previous, isEndedAtLabelCount(count)),
            );
          }}
        />
        <Show when={hubWords() || earlier()}>
          <Notice role="alert">
            {hubWords()}
            <Show when={earlier()}>
              {hubWords() ? "\n" : ""}
              <EarlierWords
                earlier={earlier()}
                record="job"
                records="jobs"
                idName="Custom ID"
                // A job's Batch of one has its Custom ID, so the Jobs list filtered to that Batch
                // shows the job.
                link={(id) => (
                  <Link to="/jobs" search={{ batchId: id }} target="_blank" preload={false}>
                    {id}
                  </Link>
                )}
                // The Custom ID names the job and its Batch of one, so a changed field and a changed
                // input are both refused at it: the hub refuses other content under a Batch's ID,
                // and under a job's Custom ID in its Batch.
                repeat={(link) => (
                  <>
                    The hub may already have a job under this Custom ID: {link}. Submit again to
                    find out: if it was made, the same values return that job and changed ones are
                    refused at Custom ID. To submit another job, change the Custom ID or clear it.
                  </>
                )}
              />
            </Show>
          </Notice>
        </Show>
        <button class="primary" type="submit" aria-disabled={pending() ? "true" : undefined}>
          Submit job
        </button>
        <p role="status" class={pending() ? "note" : "vh"}>
          {pending() ? "Working…" : ""}
        </p>
      </form>
      <Show when={submission.blocker().status === "blocked"}>
        <LeaveDialog submission={submission} record="job" list="Jobs" loses="what you typed" />
      </Show>
    </>
  );
}
