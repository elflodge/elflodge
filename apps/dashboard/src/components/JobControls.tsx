import { useQueryClient } from "@tanstack/solid-query";
import { problemOf, type Job } from "contract";
import { Show, createSignal, flush } from "solid-js";

import { api, hubFailureMessage } from "../api-client.ts";
import { formatJobUsd } from "../format.ts";
import { orpc } from "../query.ts";
import { ConfirmAction } from "./ConfirmAction.tsx";
import { FieldError } from "./FieldError.tsx";
import { BesideStatus, JobStatus } from "./JobStatus.tsx";
import { Notice } from "./Notice.tsx";

type Control = "pause" | "resume" | "cancel" | "delete";

function cancelConsequence(job: Job) {
  const finality = job.startedAt
    ? "Not final: it can be resumed."
    : "Final: it has not started, so it cannot be resumed.";
  if (job.pendingControl?.type === "pause") return `Cancel replaces the waiting pause. ${finality}`;
  if (job.status === "paused") return `Cancel ends it now. ${finality}`;
  if (job.status === "running" && job.runner)
    return `Cancel ${job.statusUnknown ? "waits for" : "asks"} ${job.runner.name} to stop it. ${finality}`;
  return job.startedAt ? "Cancel is not final: it can be resumed." : `Cancel ends it. ${finality}`;
}

export function JobControls(props: {
  job: Job;
  resumeOffered: boolean;
  deletedHere: boolean;
  onDeleted: () => void;
}) {
  const client = useQueryClient();
  const [pageFailure, setPageFailure] = createSignal<string>();
  const [budgetFailure, setBudgetFailure] = createSignal<{ message: string; field: boolean }>();
  const [pending, setPending] = createSignal(false);
  let budgetDialog: HTMLDialogElement | undefined;
  let budgetField: HTMLInputElement | undefined;
  let status: HTMLDivElement | undefined;
  let deletionNotice: HTMLDivElement | undefined;
  let failureNotice: HTMLDivElement | undefined;

  function showPageFailure(message: string) {
    setPageFailure(message);
    flush();
    failureNotice?.focus();
  }

  async function act(control: Control, modelBudgetUsd?: number) {
    setPending(true);
    setPageFailure(undefined);
    setBudgetFailure(undefined);
    const id = props.job.id;
    const queryKey = orpc.jobs.get.queryKey({ input: { id } });
    try {
      const job =
        control === "resume"
          ? await api.jobs.resume({ id, modelBudgetUsd })
          : await api.jobs[control]({ id });
      // An older poll still on the wire must not replace the control's answer.
      await client.cancelQueries({ queryKey, exact: true });
      client.setQueryData(queryKey, job);
      if (control === "delete") props.onDeleted();
      budgetDialog?.close();
      flush();
      (deletionNotice ?? status)?.focus();
      void client.invalidateQueries({ queryKey: orpc.jobs.list.key() });
      void client.invalidateQueries({ queryKey: orpc.jobs.counts.key() });
      return undefined;
    } catch (error) {
      const message = hubFailureMessage(error);
      if (modelBudgetUsd !== undefined && budgetDialog?.open && budgetDialog.isConnected) {
        // Resume sends the validated job ID and one editable field. Its 400 is the budget’s refusal.
        setBudgetFailure({ message, field: problemOf(error)?.status === 400 });
        flush();
        budgetField?.focus();
        return undefined;
      }
      return message;
    } finally {
      setPending(false);
    }
  }

  async function press(control: Control, modelBudgetUsd?: number) {
    const message = await act(control, modelBudgetUsd);
    if (message) showPageFailure(message);
  }

  const active = () => props.job.status === "queued" || props.job.status === "running";
  const stopped = () => props.job.status === "failed" || props.job.status === "cancelled";
  const spent = () =>
    props.job.modelBudgetUsd !== undefined &&
    props.job.usage.cost.totalUsd >= props.job.modelBudgetUsd;
  const cancel = () => active() || props.job.status === "paused";
  const waiting = () => props.job.pendingControl?.type;

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
          <JobStatus job={props.job} />
        </div>
        <BesideStatus job={props.job} detailed />
        <Show when={props.job.statusUnknown}>
          <p class="note">
            It may still be running on its Runner’s host.{" "}
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
        <Show
          when={!props.job.deletedAt && stopped() && (!props.job.startedAt || !props.job.runner)}
        >
          <p class="note">
            {props.job.startedAt
              ? "Its Runner was removed, so it cannot be resumed."
              : "It ended before it started, so it cannot be resumed."}
          </p>
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
      <Show when={pageFailure()}>
        {(message) => (
          <Notice
            role="alert"
            focusRef={(element) => {
              failureNotice = element;
            }}
          >
            {message()}
          </Notice>
        )}
      </Show>
      <Show when={!props.job.deletedAt}>
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
            <dialog
              aria-labelledby="resume-heading"
              ref={(element) => {
                budgetDialog = element;
              }}
            >
              <form
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (!budgetField || pending()) return;
                  await press("resume", budgetField.valueAsNumber);
                }}
              >
                <h2 id="resume-heading" class="dialog-h">
                  Resume the job
                </h2>
                <div class="dialog-b">
                  <div class="field">
                    <label for="job-budget">New model budget (USD)</label>
                    <input
                      id="job-budget"
                      type="number"
                      required
                      min="0"
                      step="any"
                      readonly={pending()}
                      aria-invalid={budgetFailure()?.field ? "true" : undefined}
                      aria-describedby={
                        budgetFailure()?.field ? "spent-budget budget-error" : "spent-budget"
                      }
                      onInput={() => setBudgetFailure(undefined)}
                      autofocus
                      ref={(element) => {
                        budgetField = element;
                      }}
                    />
                    <Show when={budgetFailure()?.field && budgetFailure()?.message}>
                      {(message) => <FieldError id="budget-error">{message()}</FieldError>}
                    </Show>
                    <p id="spent-budget" class="note">
                      Cost so far {formatJobUsd(props.job.usage.cost.totalUsd, "cost")} USD, est.
                      The new budget must exceed this cost.
                    </p>
                  </div>
                  <Show when={pending()}>
                    <p class="note" role="status">
                      Working…
                    </p>
                  </Show>
                  <Show when={!budgetFailure()?.field && budgetFailure()?.message}>
                    {(message) => <Notice role="alert">{message()}</Notice>}
                  </Show>
                </div>
                <div class="dialog-f">
                  <button type="button" onClick={() => budgetDialog?.close()}>
                    Close
                  </button>
                  <button type="submit" class="primary" disabled={pending()}>
                    Resume the job
                  </button>
                </div>
              </form>
            </dialog>
          </Show>
          <Show when={cancel()}>
            <Show
              when={!props.job.startedAt && waiting() !== "cancel"}
              fallback={
                <button
                  class="danger"
                  type="button"
                  aria-describedby={waiting() !== "cancel" ? "cancel-note" : undefined}
                  disabled={pending() || waiting() === "cancel"}
                  onClick={() => void press("cancel")}
                >
                  Cancel
                </button>
              }
            >
              <ConfirmAction
                trigger="Cancel"
                describedBy="cancel-note"
                triggerLabel="Cancel the job"
                confirm="Cancel the job"
                heading="Cancel this job?"
                disabled={pending()}
                act={() => act("cancel")}
                reportPageFailure={showPageFailure}
              >
                <p>{cancelConsequence(props.job)}</p>
              </ConfirmAction>
            </Show>
          </Show>
          <Show when={!cancel()}>
            <ConfirmAction
              trigger="Delete"
              describedBy="delete-note"
              triggerLabel="Delete the job"
              confirm="Delete the job"
              heading="Delete this job?"
              disabled={pending()}
              act={() => act("delete")}
              reportPageFailure={showPageFailure}
            >
              <p>
                Its input, Input files, Events and Output go from the hub now
                <Show when={props.job.runner}>
                  {(runner) => (
                    <>, and from {runner().name} once that Runner has deleted its files</>
                  )}
                </Show>
                . Its Usage record stays.
              </p>
            </ConfirmAction>
          </Show>
        </div>
        <Show when={resumeNote()}>
          <p class="note" id="resume-note">
            <Show when={spent()}>Resume asks for a larger model budget.</Show>
            <Show when={journalLost()}>
              {spent() ? " " : ""}Resume carries on only once its journal is restored on its Runner.
              Submitting the job again under a new custom ID starts it over.
            </Show>
          </p>
        </Show>
        <Show when={cancel() && waiting() !== "cancel"}>
          <p class="note" id="cancel-note">
            {cancelConsequence(props.job)}
          </p>
        </Show>
        <Show when={!cancel()}>
          <p class="note" id="delete-note">
            Delete removes its input, Events and Output for good. Its Usage record stays.
          </p>
        </Show>
      </Show>
    </>
  );
}
