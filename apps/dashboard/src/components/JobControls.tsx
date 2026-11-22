import { useMutation, useQueryClient } from "@tanstack/solid-query";
import { FINAL_JOB_STATUSES, type Job } from "contract";
import { Show, createSignal, flush, onFlush } from "solid-js";

import { hubFailureMessage } from "../api-client.ts";
import { focusIfLost, focusRefusedField, formRefusal } from "../form.ts";
import { USD_THRESHOLD } from "../format.ts";
import { orpc } from "../query.ts";
import { ConfirmAction } from "./ConfirmAction.tsx";
import { Field } from "./Field.tsx";
import { BesideStatus, JobStatus } from "./JobStatus.tsx";
import { Notice } from "./Notice.tsx";

type Control = "pause" | "resume" | "cancel" | "delete";

function cancelConsequence(job: Job) {
  const sentBeforeStart = job.status === "queued" && !!job.runner && !job.startedAt;
  const finality = sentBeforeStart
    ? "Final if it has not started by then; otherwise it can be resumed."
    : job.startedAt
      ? "Not final: it can be resumed."
      : "Final: it has not started, so it cannot be resumed.";
  if (job.pendingControl?.type === "pause") return `Cancel replaces the waiting pause. ${finality}`;
  if (job.status === "paused") return `Cancel ends it now. ${finality}`;
  if ((job.status === "running" || sentBeforeStart) && job.runner)
    return `Cancel ${job.statusUnknown ? "waits for" : "asks"} ${job.runner.name} to stop it. ${finality}`;
  return job.startedAt
    ? "Cancel is not final: it can be resumed."
    : `Cancel ends it now. ${finality}`;
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
  const [budgetFailure, setBudgetFailure] = createSignal<ReturnType<typeof formRefusal>>();
  let budgetDialog: HTMLDialogElement | undefined;
  let budgetField: HTMLInputElement | undefined;
  let status: HTMLDivElement | undefined;
  let deletionNotice: HTMLDivElement | undefined;
  let failureNotice: HTMLDivElement | undefined;

  function showPageFailure(control: Control, message: string) {
    setPageFailure(`${control[0].toUpperCase()}${control.slice(1)}: ${message}`);
    flush();
    focusIfLost(failureNotice);
  }

  async function act(control: Control, modelBudgetUsd?: number) {
    // On their own: written beside the request, they would be held until the request settles.
    onFlush(() => {
      setPageFailure(undefined);
      setBudgetFailure(undefined);
    });
    const id = props.job.id;
    try {
      // Resolves once the job the hub answered, written in onSuccess, is on screen.
      if (control === "resume") await controls.resume.mutate({ id, modelBudgetUsd });
      else await controls[control].mutate({ id });
    } catch (error) {
      if (modelBudgetUsd !== undefined && budgetDialog?.open && budgetDialog.isConnected) {
        setBudgetFailure(formRefusal(error, { budget: ["modelBudgetUsd"] }));
        return undefined;
      }
      return hubFailureMessage(error);
    }
    budgetDialog?.close();
    (deletionNotice ?? status)?.focus();
    void client.invalidateQueries({ queryKey: orpc.jobs.list.key() });
    void client.invalidateQueries({ queryKey: orpc.jobs.counts.key() });
    return undefined;
  }

  async function press(control: Control, modelBudgetUsd?: number) {
    const message = await act(control, modelBudgetUsd);
    if (message) showPageFailure(control, message);
  }

  // createFormAction holds shared signal writes until its action settles. The budget field and
  // every job control must reflect this request while the hub is still answering it.
  async function submitBudget(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
    event.preventDefault();
    if (!props.resumeOffered || !budgetField || pending()) return;
    const { currentTarget, submitter } = event;
    const focused = document.activeElement;
    await press("resume", budgetField.valueAsNumber);
    if (budgetDialog?.open) {
      flush();
      if (!focusRefusedField(currentTarget, focused)) focusIfLost(submitter);
    }
  }

  const active = () =>
    !props.job.deletedAt && (props.job.status === "queued" || props.job.status === "running");
  const spent = () =>
    props.job.modelBudgetUsd !== undefined &&
    props.job.usage.cost.totalUsd >= props.job.modelBudgetUsd;
  const canCancel = () => !FINAL_JOB_STATUSES.includes(props.job.status);
  const waiting = () => props.job.pendingControl?.type;

  const cancelAvailable = () => !props.job.deletedAt && canCancel() && waiting() !== "cancel";
  const confirmCancel = () =>
    cancelAvailable() && props.job.status !== "running" && !props.job.startedAt;
  const deleteAvailable = () => !props.job.deletedAt && !canCancel();
  const focusStatusIfLost = () => focusIfLost(deletionNotice ?? status);

  const journalLost = () =>
    props.job.status === "failed" && props.job.failure.reason === "journalLost";
  const resumeNote = () => props.resumeOffered && (spent() || journalLost());

  return (
    <>
      <div
        class="job-status"
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
        <Show when={pending()}>
          <p class="note">Working…</p>
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
        <Show when={active() && waiting() !== "cancel"}>
          <button
            type="button"
            disabled={pending() || waiting() === "pause"}
            onClick={() => void press("pause")}
          >
            Pause
          </button>
        </Show>
        <Show when={props.resumeOffered}>
          <button
            type="button"
            disabled={pending()}
            aria-describedby={resumeNote() ? "resume-note" : undefined}
            onClick={() => {
              if (!spent()) {
                void press("resume");
                return;
              }
              setBudgetFailure(undefined);
              if (budgetField) budgetField.value = "";
              flush();
              budgetDialog?.showModal();
            }}
          >
            Resume
          </button>
        </Show>
        <dialog
          onClose={focusStatusIfLost}
          aria-labelledby="resume-heading"
          ref={(element) => {
            budgetDialog = element;
          }}
        >
          <form onSubmit={submitBudget}>
            <h2 id="resume-heading" class="dialog-h">
              Resume the job
            </h2>
            <div class="dialog-b">
              <Field
                label="New model budget"
                unit="USD"
                hint={`Cost so far ${USD_THRESHOLD.format(props.job.usage.cost.totalUsd)} USD, est. The new budget must exceed this cost.`}
                error={budgetFailure()?.fields.get("budget")}
              >
                {(control) => (
                  <input
                    {...control}
                    name="modelBudgetUsd"
                    type="number"
                    required
                    min="0"
                    step="any"
                    readonly={pending()}
                    onInput={() => setBudgetFailure(undefined)}
                    autofocus
                    ref={(element) => {
                      budgetField = element;
                    }}
                  />
                )}
              </Field>
              <Show when={!props.resumeOffered}>
                <p role="status">{props.cannotResume ?? "This job can no longer be resumed."}</p>
              </Show>
              <Show when={pending()}>
                <p class="note" role="status">
                  Working…
                </p>
              </Show>
              <Show when={budgetFailure()?.alert} keyed>
                {(message) => <Notice role="alert">{message}</Notice>}
              </Show>
            </div>
            <div class="dialog-f">
              {/* Not "Cancel", as other form dialogs say: on a job's page, Cancel cancels the job. */}
              <button type="button" onClick={() => budgetDialog?.close()}>
                Close
              </button>
              <button type="submit" class="primary" disabled={pending() || !props.resumeOffered}>
                Resume the job
              </button>
            </div>
          </form>
        </dialog>
        <Show when={!props.job.deletedAt && canCancel() && !confirmCancel()}>
          <button
            class="danger"
            type="button"
            aria-describedby={waiting() !== "cancel" ? "cancel-note" : undefined}
            disabled={pending() || waiting() === "cancel"}
            onClick={() => void press("cancel")}
          >
            Cancel
          </button>
        </Show>
        <ConfirmAction
          trigger="Cancel"
          showTrigger={confirmCancel()}
          canConfirm={cancelAvailable()}
          onClose={focusStatusIfLost}
          describedBy="cancel-note"
          triggerLabel="Cancel the job"
          confirm="Cancel the job"
          heading="Cancel this job?"
          disabled={pending()}
          act={() => act("cancel")}
          reportPageFailure={(message) => showPageFailure("cancel", message)}
        >
          <p>
            {cancelAvailable()
              ? cancelConsequence(props.job)
              : waiting() === "cancel"
                ? "Cancel has already been asked."
                : "This job can no longer be cancelled."}
          </p>
        </ConfirmAction>
        <ConfirmAction
          trigger="Delete"
          showTrigger={deleteAvailable()}
          canConfirm={deleteAvailable()}
          onClose={focusStatusIfLost}
          describedBy="delete-note"
          triggerLabel="Delete the job"
          confirm="Delete the job"
          heading="Delete this job?"
          disabled={pending()}
          act={() => act("delete")}
          reportPageFailure={(message) => showPageFailure("delete", message)}
        >
          <Show when={deleteAvailable()} fallback={<p>This job can no longer be deleted.</p>}>
            <p>
              Its input, Input files, Events and Output go from the hub now
              <Show when={props.job.runner} keyed>
                {(runner) => <>, and from {runner.name} once that Runner has deleted its files</>}
              </Show>
              . Its Usage record stays.
            </p>
          </Show>
        </ConfirmAction>
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
    </>
  );
}
