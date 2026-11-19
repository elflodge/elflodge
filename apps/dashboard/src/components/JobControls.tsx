import { useMutation, useQueryClient } from "@tanstack/solid-query";
import type { Job } from "contract";
import { Show, createSignal, flush } from "solid-js";

import { api, hubFailureMessage } from "../api-client.ts";
import { formatUsd } from "../format.ts";
import { orpc } from "../query.ts";
import { ConfirmAction } from "./ConfirmAction.tsx";
import { BesideStatus, JobStatus } from "./JobStatus.tsx";
import { Notice } from "./Notice.tsx";

type Control = "pause" | "resume" | "cancel" | "delete";

function cancelConsequence(job: Job) {
  const finality = job.startedAt
    ? "Not final: it can be resumed."
    : "Final: it has not started, so it cannot be resumed.";
  if (job.pendingControl?.type === "pause") return `Replaces the waiting pause. ${finality}`;
  if (job.status === "paused") return `Ends it now. ${finality}`;
  if (job.status === "running" && job.runner)
    return `${job.statusUnknown ? "Waits for" : "Asks"} ${job.runner.name} to stop it. ${finality}`;
  return job.startedAt ? finality : `Ends it. ${finality}`;
}

export function JobControls(props: { job: Job; deletedHere: boolean; onDeleted: () => void }) {
  const client = useQueryClient();
  const [pageFailure, setPageFailure] = createSignal<string>();
  const [budgetFailure, setBudgetFailure] = createSignal<string>();
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

  const change = useMutation(() => ({
    mutationFn: ({
      control,
      id,
      modelBudgetUsd,
    }: {
      control: Control;
      id: string;
      modelBudgetUsd?: number;
    }) =>
      control === "resume" ? api.jobs.resume({ id, modelBudgetUsd }) : api.jobs[control]({ id }),
  }));

  async function act(control: Control, modelBudgetUsd?: number) {
    setPageFailure(undefined);
    setBudgetFailure(undefined);
    const id = props.job.id;
    const queryKey = orpc.jobs.get.queryKey({ input: { id } });
    try {
      const job = await change.mutate({ control, id, modelBudgetUsd });
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
      return hubFailureMessage(error);
    }
  }

  async function press(control: Control) {
    const message = await act(control);
    if (message) showPageFailure(message);
  }

  const active = () => props.job.status === "queued" || props.job.status === "running";
  const stopped = () => props.job.status === "failed" || props.job.status === "cancelled";
  const resume = () =>
    !props.job.pendingControl &&
    (props.job.status === "paused" || (stopped() && props.job.startedAt && props.job.runner));
  const spent = () =>
    props.job.modelBudgetUsd !== undefined &&
    props.job.usage.cost.totalUsd >= props.job.modelBudgetUsd;
  const cancel = () => active() || props.job.status === "paused";
  const waiting = () => props.job.pendingControl?.type;

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
            It may still be running on its Runner’s host. A pause or cancel asked now waits for its
            Runner. Removing the Runner ends this job as <code>runnerRemoved</code>.
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
        <Show when={change.isPending}>
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
              disabled={change.isPending || waiting() === "pause"}
              onClick={() => void press("pause")}
            >
              Pause
            </button>
          </Show>
          <Show when={resume()}>
            <button
              type="button"
              disabled={change.isPending}
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
                  if (!budgetField || change.isPending) return;
                  const message = await act("resume", budgetField.valueAsNumber);
                  if (message) {
                    if (budgetDialog?.open && budgetDialog.isConnected) {
                      setBudgetFailure(message);
                      budgetField.focus();
                    } else showPageFailure(message);
                  }
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
                      aria-describedby="spent-budget"
                      autofocus
                      ref={(element) => {
                        budgetField = element;
                      }}
                    />
                    <p id="spent-budget" class="note">
                      Cost so far {formatUsd(props.job.usage.cost.totalUsd)} USD, est. The new
                      budget must exceed this cost.
                    </p>
                  </div>
                  <Show when={change.isPending}>
                    <p class="note" role="status">
                      Working…
                    </p>
                  </Show>
                  <Show when={budgetFailure()}>
                    {(message) => <Notice role="alert">{message()}</Notice>}
                  </Show>
                </div>
                <div class="dialog-f">
                  <button type="button" onClick={() => budgetDialog?.close()}>
                    Close
                  </button>
                  <button type="submit" class="primary" disabled={change.isPending}>
                    Resume the job
                  </button>
                </div>
              </form>
            </dialog>
          </Show>
          <Show when={cancel()}>
            <div class="ctl">
              <Show
                when={!props.job.startedAt && waiting() !== "cancel"}
                fallback={
                  <button
                    class="danger"
                    type="button"
                    disabled={change.isPending || waiting() === "cancel"}
                    onClick={() => void press("cancel")}
                  >
                    Cancel
                  </button>
                }
              >
                <ConfirmAction
                  trigger="Cancel"
                  triggerLabel="Cancel the job"
                  confirm="Cancel the job"
                  heading="Cancel this job?"
                  disabled={change.isPending}
                  act={() => act("cancel")}
                  reportPageFailure={showPageFailure}
                >
                  <p>{cancelConsequence(props.job)}</p>
                </ConfirmAction>
              </Show>
              <Show when={waiting() !== "cancel"}>
                <span class="consequence">{cancelConsequence(props.job)}</span>
              </Show>
            </div>
          </Show>
          <Show when={!cancel()}>
            <div class="ctl">
              <ConfirmAction
                trigger="Delete"
                triggerLabel="Delete the job"
                confirm="Delete the job"
                heading="Delete this job?"
                disabled={change.isPending}
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
              <span class="consequence">
                Removes its input, Events and Output for good. Its Usage record stays.
              </span>
            </div>
          </Show>
        </div>
      </Show>
    </>
  );
}
