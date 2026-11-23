import { useMutation, useQueryClient } from "@tanstack/solid-query";
import { AlertDialogTrigger, createAlertDialogController } from "@ui-sdk/solid/alert-dialog";
import { Button } from "@ui-sdk/solid/button";
import { DialogTrigger, createDialogController } from "@ui-sdk/solid/dialog";
import { FINAL_JOB_STATUSES, type Job } from "contract";
import { Show, createSignal, flush, onFlush } from "solid-js";

import { hubWriteFailureMessage } from "../api-client.ts";
import { fieldText, focusIfLost, formRefusal } from "../form.ts";
import { USD_THRESHOLD } from "../format.ts";
import { orpc, untilFlushed } from "../query.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Field } from "./Field.tsx";
import { FormDialog } from "./FormDialog.tsx";
import { BesideStatus, JobStatus } from "./JobStatus.tsx";
import { Notice } from "./Notice.tsx";

type Control = "pause" | "resume" | "cancel" | "delete";
/** The controls that ask first. */
type Confirmed = "cancel" | "delete";

/** What Cancel ends, then whether that is final: the whole of its question's explanation. */
function cancelConsequence(job: Job) {
  const runner = job.runner?.name || "its Runner";
  const sentBeforeStart = job.status === "queued" && !!job.runner && !job.startedAt;
  // Only a job sent to a Runner can have its status unknown.
  const sent = job.status === "running" || sentBeforeStart || !!job.statusUnknown;
  const finality = sentBeforeStart
    ? "Final if it has not started by then; otherwise it can be resumed."
    : job.startedAt
      ? "Not final: it can be resumed."
      : "Final: it has not started, so it cannot be resumed.";
  const stop = `${job.statusUnknown ? "waits for" : "asks"} ${runner} to stop it`;
  if (job.pendingControl?.type === "pause")
    return `Cancel replaces the waiting pause and ${stop}. ${finality}`;
  if (job.status === "paused") return `Cancel ends it now. ${finality}`;
  if (sent) return `Cancel ${stop}. ${finality}`;
  // Queued again by a resume: the hub ends a run not yet sent and asks the Runner to stop one it
  // was sent, which the record does not tell apart.
  if (job.startedAt)
    return `Cancel ends it now, or ${stop} if it has been sent there again. ${finality}`;
  return `Cancel ends it now. ${finality}`;
}

export function JobControls(props: {
  job: Job;
  resumeOffered: boolean;
  lastRecorded: boolean;
  cannotResume?: string;
  deletedHere: boolean;
  onDeleted: () => void;
}) {
  const client = useQueryClient();
  // The hub answers a control with the job as it now stands. The job read and any Events read that
  // can reach the newest end can replace the record, so they are cancelled first.
  async function writeJob(job: Job) {
    const { id } = job;
    const queryKey = orpc.jobs.get.queryKey({ input: { id } });
    await Promise.all([
      client.cancelQueries({ queryKey, exact: true }),
      client.cancelQueries({
        queryKey: orpc.jobs.events.key({ type: "infinite", input: { id, order: "desc" } }),
        predicate: (query) => !query.state.fetchMeta?.fetchMore,
      }),
      client.cancelQueries({
        queryKey: orpc.jobs.events.key({ input: { id, order: "asc" } }),
      }),
    ]);
    // The hub's answer is the newest fact, written even after the job read answered 404: the page
    // then shows the record until the next read.
    client.setQueryData(queryKey, job);
  }
  const controls = {
    pause: useMutation(() => orpc.jobs.pause.mutationOptions({ onSuccess: writeJob })),
    resume: useMutation(() => orpc.jobs.resume.mutationOptions({ onSuccess: writeJob })),
    cancel: useMutation(() => orpc.jobs.cancel.mutationOptions({ onSuccess: writeJob })),
    delete: useMutation(() =>
      orpc.jobs.delete.mutationOptions({
        // With the record, so the deletion notice is there to take focus.
        onSuccess: async (job) => {
          await writeJob(job);
          props.onDeleted();
        },
      }),
    ),
  };
  const pending = () => Object.values(controls).some((control) => control.isPending);
  const [pageFailure, setPageFailure] = createSignal<string>();
  let status: HTMLDivElement | undefined;
  let deletionNotice: HTMLDivElement | undefined;
  let failureNotice: HTMLDivElement | undefined;

  function showPageFailure(control: Control, message: string) {
    setPageFailure(`${control[0].toUpperCase()}${control.slice(1)}: ${message}`);
    flush();
    focusIfLost(failureNotice);
  }

  /** Sends `control`, and resolves once the page shows the hub's answer; rejects with its failure. */
  async function run(control: Control, modelBudgetUsd?: number) {
    // Clear an earlier failure while the hub is answering.
    onFlush(() => setPageFailure(undefined));
    const id = props.job.id;
    if (control === "resume") await controls.resume.mutate({ id, modelBudgetUsd });
    else await controls[control].mutate({ id });
    // Applies pending renders, so the deletion notice onSuccess asked for is there to take focus.
    flush();
  }

  function readListsAgain() {
    void client.invalidateQueries({ queryKey: orpc.jobs.list.key() });
    void client.invalidateQueries({ queryKey: orpc.jobs.counts.key() });
  }

  // Pause and Resume keep the focus while they run, and the status takes it once the hub answers.
  async function press(control: "pause" | "resume") {
    await untilFlushed();
    try {
      await run(control);
    } catch (error) {
      showPageFailure(control, hubWriteFailureMessage(error));
      return;
    }
    status?.focus();
    readListsAgain();
  }

  // The dialog closes once `confirmed` resolves, with focus on the status or the deletion notice.
  async function confirmed(control: Confirmed) {
    await run(control);
    readListsAgain();
  }

  const active = () =>
    !props.job.deletedAt && (props.job.status === "queued" || props.job.status === "running");
  const spent = () =>
    props.job.modelBudgetUsd !== undefined &&
    props.job.usage.cost.totalUsd >= props.job.modelBudgetUsd;
  // A poll may change which Resume is offered. Keep the part that sent the request until it ends.
  const resumeNeedsBudget = () =>
    controls.resume.isPending ? controls.resume.variables?.modelBudgetUsd !== undefined : spent();
  function budgetWithdrawn() {
    if (!props.resumeOffered) return props.cannotResume ?? "This job can no longer be resumed.";
    if (!spent()) return "Its model budget was raised, so it resumes without a new one.";
    return undefined;
  }
  const canCancel = () => !FINAL_JOB_STATUSES.includes(props.job.status);
  const waiting = () => props.job.pendingControl?.type;

  const deleteAvailable = () => !props.job.deletedAt && !canCancel();
  const budget = createDialogController();
  const confirm = createAlertDialogController<Confirmed>();
  // Read live, as the open dialog's words are.
  function withdrawn(control: Confirmed) {
    if (props.job.deletedAt) return "This job has already been deleted.";
    if (control === "delete") return canCancel() ? "This job can no longer be deleted." : undefined;
    if (waiting() === "cancel") return "Cancel has already been asked.";
    return canCancel() ? undefined : "This job can no longer be cancelled.";
  }

  const journalLost = () =>
    props.job.status === "failed" && props.job.failure.reason === "journalLost";
  const resumeNote = () => props.resumeOffered && (spent() || journalLost());

  return (
    <>
      <div
        class="job-status"
        id="job-status"
        role="status"
        tabindex="-1"
        ref={(element) => {
          status = element;
        }}
      >
        <div class="status-lg">
          <JobStatus status={props.job.status} lastRecorded={props.lastRecorded} />
        </div>
        <BesideStatus job={props.job} detailed />
        <Show when={props.job.statusUnknown}>
          <p class="note">
            {props.job.startedAt
              ? "It may still be running on its Runner’s host."
              : "It may have started on its Runner’s host."}{" "}
            <Show
              when={waiting() === "cancel"}
              fallback={
                <>
                  {waiting() === "pause"
                    ? "Cancel replaces the waiting pause."
                    : "A pause or cancel asked now waits for its Runner."}{" "}
                  Removing the Runner ends this job as <code>runnerRemoved</code>.
                </>
              }
            >
              Removing the Runner ends this job as cancelled.
            </Show>
          </p>
        </Show>
        <Show when={props.cannotResume} keyed>
          {(reason) => <p class="note">{reason}</p>}
        </Show>
        {/* The pressed button or the open dialog announces the wait. */}
        <Show when={pending()}>
          <p class="note" aria-hidden="true">
            Working…
          </p>
        </Show>
      </div>
      <Show when={props.deletedHere}>
        <Notice
          role="status"
          focusRef={(element) => {
            deletionNotice = element;
          }}
        >
          Deleted. Its Usage record stays.
        </Notice>
      </Show>
      <Show when={pageFailure()} keyed>
        {(message) => (
          <Notice
            role="alert"
            focusRef={(element) => {
              failureNotice = element;
            }}
          >
            {message}
          </Notice>
        )}
      </Show>
      <div class="controls job-controls">
        {/* Disabled, each control keeps the focus while another runs, as the one running does, and
            stays while its own request runs, whatever a read says meanwhile. */}
        <Show when={(active() && waiting() !== "cancel") || controls.pause.isPending}>
          <Button
            disabled={pending() || waiting() === "pause"}
            focusableWhenDisabled
            aria-describedby={waiting() === "pause" ? "job-status" : undefined}
            pendingAnnouncement="Working…"
            onClick={() => press("pause")}
          >
            Pause
          </Button>
        </Show>
        <Show when={props.resumeOffered || controls.resume.isPending}>
          <Show
            when={resumeNeedsBudget()}
            fallback={
              <Button
                disabled={pending()}
                focusableWhenDisabled
                pendingAnnouncement="Working…"
                aria-describedby={resumeNote() ? "resume-note" : undefined}
                onClick={() => press("resume")}
              >
                Resume
              </Button>
            }
          >
            <DialogTrigger
              controller={budget}
              disabled={pending()}
              focusableWhenDisabled
              aria-describedby={resumeNote() ? "resume-note" : undefined}
            >
              Resume
            </DialogTrigger>
          </Show>
        </Show>
        <Show when={!props.job.deletedAt && canCancel()}>
          <AlertDialogTrigger
            controller={confirm}
            payload="cancel"
            class="danger"
            aria-label="Cancel the job"
            aria-describedby={waiting() === "cancel" ? "job-status" : "cancel-note"}
            disabled={pending() || waiting() === "cancel"}
            focusableWhenDisabled
          >
            Cancel
          </AlertDialogTrigger>
        </Show>
        <Show when={deleteAvailable()}>
          <AlertDialogTrigger
            controller={confirm}
            payload="delete"
            class="danger"
            aria-label="Delete the job"
            aria-describedby="delete-note"
            disabled={pending()}
            focusableWhenDisabled
          >
            Delete
          </AlertDialogTrigger>
        </Show>
      </div>
      <Show when={!props.job.deletedAt}>
        <Show when={resumeNote()}>
          <p class="note" id="resume-note">
            <Show when={spent()}>Resume asks for a larger model budget.</Show>
            <Show when={journalLost()}>
              {spent() ? " " : ""}Resume carries on only once its journal is restored on its Runner.
              Submitting the job again under a new custom ID starts it over.
            </Show>
          </p>
        </Show>
        <Show when={canCancel() && waiting() !== "cancel"}>
          <p class="note" id="cancel-note">
            {cancelConsequence(props.job)}
          </p>
        </Show>
        <Show when={!canCancel()}>
          <p class="note" id="delete-note">
            Delete removes its input, Input files, Events and Output for good. Its Usage record
            stays.
          </p>
        </Show>
      </Show>
      {/* Both dialogs outlive any control a poll withdraws. */}
      <FormDialog
        controller={budget}
        heading={() => "Resume the job"}
        confirm="Resume the job"
        // On this page Cancel cancels the job.
        dismissLabel="Close"
        withdrawn={budgetWithdrawn}
        refusal={(error) => formRefusal(error, { modelBudgetUsd: ["modelBudgetUsd"] })}
        send={async (form) => {
          await run("resume", Number(fieldText(new FormData(form), "modelBudgetUsd")));
          readListsAgain();
        }}
        notice={() => status}
      >
        {(fields) => (
          <Field
            label="New model budget"
            unit="USD"
            hint={`Cost so far ${USD_THRESHOLD.format(props.job.usage.cost.totalUsd)} USD, est. The new budget must exceed this cost.`}
            error={fields.refused("modelBudgetUsd")}
          >
            {(control) => (
              <input
                {...control}
                name="modelBudgetUsd"
                type="number"
                required
                min="0"
                step="any"
                readonly={fields.pending()}
              />
            )}
          </Field>
        )}
      </FormDialog>
      <ConfirmDialog
        controller={confirm}
        heading={(control) => (control === "cancel" ? "Cancel this job?" : "Delete this job?")}
        confirm={(control) => (control === "cancel" ? "Cancel the job" : "Delete the job")}
        withdrawn={withdrawn}
        act={confirmed}
        notice={() => deletionNotice ?? status}
      >
        {(control) =>
          control === "cancel" ? (
            <p>{cancelConsequence(props.job)}</p>
          ) : (
            <p>
              Its input, Input files, Events and Output go from the hub now
              <Show when={!!props.job.runner}>
                {props.job.runner?.name
                  ? `, and from ${props.job.runner.name} once that Runner has deleted its files`
                  : ", and from its Runner once it has deleted its files"}
              </Show>
              . Its Usage record stays.
            </p>
          )
        }
      </ConfirmDialog>
    </>
  );
}
