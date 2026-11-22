import { useMutation, useQueryClient } from "@tanstack/solid-query";
import type { Batch } from "contract";
import { Show, createSignal, flush, onFlush } from "solid-js";

import { hubFailureMessage } from "../api-client.ts";
import { unfinishedJobs } from "../batch.ts";
import { focusIfLost } from "../form.ts";
import { formatCount, plural } from "../format.ts";
import { orpc } from "../query.ts";
import { BatchConditions, BatchStatus } from "./BatchStatus.tsx";
import { ConfirmAction } from "./ConfirmAction.tsx";
import { Notice } from "./Notice.tsx";

const finality = "It takes no new jobs, and none of its jobs can be resumed.";

export function BatchControls(props: { batch: Batch }) {
  const client = useQueryClient();
  // The hub answers a control with the Batch as it now stands, which an older read must not replace.
  async function writeBatch(batch: Batch) {
    const queryKey = orpc.batches.get.queryKey({ input: { id: batch.id } });
    await client.cancelQueries({ queryKey, exact: true });
    client.setQueryData(queryKey, batch);
  }
  const controls = {
    pause: useMutation(() => orpc.batches.pause.mutationOptions({ onSuccess: writeBatch })),
    resume: useMutation(() => orpc.batches.resume.mutationOptions({ onSuccess: writeBatch })),
    cancel: useMutation(() => orpc.batches.cancel.mutationOptions({ onSuccess: writeBatch })),
  };
  const pending = () => Object.values(controls).some((control) => control.isPending);
  const [failure, setFailure] = createSignal<string>();
  let status: HTMLDivElement | undefined;
  let alert: HTMLDivElement | undefined;
  function showFailure(message: string) {
    setFailure(message);
    flush();
    focusIfLost(alert);
  }
  async function act(control: "pause" | "resume" | "cancel", close?: () => boolean) {
    // On its own: written beside the request, it would be held until the request settles.
    onFlush(() => setFailure(undefined));
    try {
      // Resolves once the Batch the hub answered, written in onSuccess, is on screen.
      await controls[control].mutate({ id: props.batch.id });
    } catch (error) {
      return hubFailureMessage(error);
    }
    const closed = close?.();
    if (closed === false) focusIfLost(status);
    else status?.focus();
    void client.invalidateQueries({ queryKey: orpc.batches.list.key() });
    void client.invalidateQueries({ queryKey: orpc.jobs.list.key() });
    void client.invalidateQueries({ queryKey: orpc.jobs.counts.key() });
    void client.invalidateQueries({ queryKey: orpc.jobs.get.key() });
    return undefined;
  }
  async function press(control: "pause" | "resume") {
    const message = await act(control);
    if (message) showFailure(`${control === "pause" ? "Pause" : "Resume"} the Batch: ${message}`);
  }
  const cancellationStarted = () =>
    !!props.batch.pendingControl || props.batch.status === "cancelled";
  const cancelLabel = () => `Cancel the Batch ${props.batch.id}`;
  const unfinished = () => unfinishedJobs(props.batch.jobCounts);
  const unfinishedText = () =>
    `${formatCount(unfinished())} unfinished ${plural(unfinished(), "job", "jobs")}`;
  const resumeExplanation = () => {
    const { breaker, pausedBy } = props.batch;
    const canary = breaker ? breaker.canary : 0;
    const byBreaker = pausedBy === "breaker" && !!breaker;
    if (byBreaker && canary)
      return `Resume starts a new Canary of the next ${formatCount(canary)} ${plural(canary, "job", "jobs")} and counts failures afresh.`;
    if (byBreaker) return "Resume releases its blocked jobs and counts failures afresh.";
    if (canary)
      return "Resume ends the pause. Its Canary may still hold jobs: one that is running, or a new one if its failure breaker tripped during the pause.";
    return "Resume releases its blocked jobs.";
  };
  return (
    <>
      <div
        class="job-status"
        id="batch-status"
        role="status"
        tabindex="-1"
        ref={(element) => {
          status = element;
        }}
      >
        <div class="status-lg">
          <BatchStatus batch={props.batch} />
        </div>
        <BatchConditions batch={props.batch} detailed />
        <Show when={cancellationStarted()}>
          <p class="note">{finality}</p>
        </Show>
        <Show when={pending()}>
          <p class="note">Working…</p>
        </Show>
      </div>
      <Show when={failure()} keyed>
        {(message) => (
          <Notice
            role="alert"
            focusRef={(element) => {
              alert = element;
            }}
          >
            {message}
          </Notice>
        )}
      </Show>
      <div class="controls job-controls">
        <Show when={!props.batch.pendingControl && props.batch.status === "active"}>
          <button
            type="button"
            aria-describedby="pause-note"
            disabled={pending()}
            onClick={() => void press("pause")}
          >
            Pause
          </button>
        </Show>
        <Show when={!cancellationStarted() && props.batch.status === "paused"}>
          <button
            type="button"
            aria-describedby="resume-note"
            disabled={pending()}
            onClick={() => void press("resume")}
          >
            Resume
          </button>
        </Show>
        <Show when={props.batch.pendingControl}>
          <button
            type="button"
            class="danger"
            disabled
            aria-label={cancelLabel()}
            aria-describedby="batch-status"
          >
            Cancel
          </button>
        </Show>
        <ConfirmAction
          trigger="Cancel"
          triggerLabel={cancelLabel()}
          showTrigger={!cancellationStarted()}
          canConfirm={!cancellationStarted()}
          onClose={() => focusIfLost(status)}
          confirm="Cancel the Batch"
          heading={
            <>
              Cancel the Batch <code class="job-address">{props.batch.id}</code>?
            </>
          }
          describedBy="cancel-note"
          disabled={pending()}
          act={(close) => act("cancel", close)}
          reportPageFailure={(message) => showFailure(`Cancel the Batch: ${message}`)}
        >
          <Show
            when={!cancellationStarted()}
            fallback={
              <p>
                {props.batch.status === "cancelled"
                  ? "The Batch is already cancelled."
                  : "Cancel has already been asked."}
              </p>
            }
          >
            <p>
              <Show when={unfinished()}>
                {unfinished() === 1
                  ? "Its one unfinished job is cancelled at once if it is unsent or paused. Otherwise its Runner is asked to stop it. If it ends first, it keeps its status and output."
                  : `It has ${unfinishedText()}. Unsent and paused jobs are cancelled at once. Runners are asked to stop the others. Jobs that end first keep their status and output.`}{" "}
              </Show>
              {finality}
            </p>
            <Show when={props.batch.statusUnknownJobs} keyed>
              {(n) => (
                <p>
                  {formatCount(n)} of its jobs {plural(n, "has", "have")} status unknown: the cancel
                  waits until {n === 1 ? "its Runner reports or is" : "their Runners report or are"}{" "}
                  removed.
                </p>
              )}
            </Show>
          </Show>
        </ConfirmAction>
      </div>
      <Show when={!cancellationStarted()}>
        <Show
          when={props.batch.status === "active"}
          fallback={
            <p class="note" id="resume-note">
              {resumeExplanation()}
              <Show when={props.batch.jobCounts.paused} keyed>
                {(n) => (
                  <>
                    {" "}
                    Its {formatCount(n)} paused {plural(n, "job", "jobs")}{" "}
                    {plural(n, "stays", "stay")} paused.
                  </>
                )}
              </Show>
            </p>
          }
        >
          <p class="note" id="pause-note">
            Pause blocks its jobs not yet sent to a Runner, and any added later: they stay queued.
            Jobs already sent or running carry on.
          </p>
        </Show>
        <p class="note" id="cancel-note">
          <Show when={unfinished()}>This Batch has {unfinishedText()}. </Show>Cancel is final.{" "}
          {finality}
        </p>
      </Show>
    </>
  );
}
