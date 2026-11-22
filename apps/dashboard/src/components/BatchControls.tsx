import { useMutation, useQueryClient } from "@tanstack/solid-query";
import { AlertDialogTrigger, createAlertDialogController } from "@ui-sdk/solid/alert-dialog";
import { Button } from "@ui-sdk/solid/button";
import type { Batch } from "contract";
import { Show, createSignal, flush, onFlush } from "solid-js";

import { hubWriteFailureMessage } from "../api-client.ts";
import { unfinishedJobs } from "../batch.ts";
import { focusIfLost } from "../form.ts";
import { formatCount, plural } from "../format.ts";
import { orpc, untilFlushed } from "../query.ts";
import { BatchConditions, BatchStatus } from "./BatchStatus.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Notice } from "./Notice.tsx";

const finality = "It takes no new jobs, and none of its jobs can be resumed.";

/** The Batch's counts as they were when Cancel was pressed, which every read can move. */
type CancelCounts = { unfinished: number; statusUnknown: number };

function unfinishedText(unfinished: number) {
  return `${formatCount(unfinished)} unfinished ${plural(unfinished, "job", "jobs")}`;
}

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
  /** Sends `control`, and resolves once the page shows the hub's answer; rejects with its failure. */
  async function run(control: "pause" | "resume" | "cancel") {
    // On its own: written beside the request, it would be held until it settles.
    onFlush(() => setFailure(undefined));
    await controls[control].mutate({ id: props.batch.id });
    // Shown before the reads start, which would hold it.
    flush();
  }
  function readAgain() {
    void client.invalidateQueries({ queryKey: orpc.batches.list.key() });
    void client.invalidateQueries({ queryKey: orpc.jobs.list.key() });
    void client.invalidateQueries({ queryKey: orpc.jobs.counts.key() });
    void client.invalidateQueries({ queryKey: orpc.jobs.get.key() });
  }
  // Pause and Resume keep the focus while they run, and the status takes it once the hub answers.
  async function press(control: "pause" | "resume") {
    await untilFlushed();
    try {
      await run(control);
    } catch (error) {
      showFailure(
        `${control === "pause" ? "Pause" : "Resume"} the Batch: ${hubWriteFailureMessage(error)}`,
      );
      return;
    }
    status?.focus();
    readAgain();
  }
  const confirmCancel = createAlertDialogController<CancelCounts>();
  const cancellationStarted = () =>
    !!props.batch.pendingControl || props.batch.status === "cancelled";
  const cancelLabel = () => `Cancel the Batch ${props.batch.id}`;
  const unfinished = () => unfinishedJobs(props.batch.jobCounts);
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
        {/* Seen, not read: the control or the dialog that waits announces it. */}
        <Show when={pending()}>
          <p class="note" aria-hidden="true">
            Working…
          </p>
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
        {/* Disabled, each control keeps the focus while another runs, as the one running does, and
            stays while its own request runs, whatever a read says meanwhile. */}
        <Show
          when={
            (!props.batch.pendingControl && props.batch.status === "active") ||
            controls.pause.isPending
          }
        >
          {/* Kept while its request runs, after a read removed its note, it is described by the
              status then. */}
          <Button
            aria-describedby={
              !cancellationStarted() && props.batch.status === "active"
                ? "pause-note"
                : "batch-status"
            }
            disabled={pending()}
            focusableWhenDisabled
            pendingAnnouncement="Working…"
            onClick={() => press("pause")}
          >
            Pause
          </Button>
        </Show>
        <Show
          when={
            (!cancellationStarted() && props.batch.status === "paused") || controls.resume.isPending
          }
        >
          <Button
            aria-describedby={
              !cancellationStarted() && props.batch.status !== "active"
                ? "resume-note"
                : "batch-status"
            }
            disabled={pending()}
            focusableWhenDisabled
            pendingAnnouncement="Working…"
            onClick={() => press("resume")}
          >
            Resume
          </Button>
        </Show>
        {/* A cancel awaiting its Runners keeps its button, which the status explains. */}
        <Show when={props.batch.pendingControl || props.batch.status !== "cancelled"}>
          <AlertDialogTrigger
            controller={confirmCancel}
            payload={{ unfinished: unfinished(), statusUnknown: props.batch.statusUnknownJobs }}
            class="danger"
            aria-label={cancelLabel()}
            aria-describedby={props.batch.pendingControl ? "batch-status" : "cancel-note"}
            disabled={pending() || !!props.batch.pendingControl}
            focusableWhenDisabled
          >
            Cancel
          </AlertDialogTrigger>
        </Show>
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
          <Show when={unfinished()}>This Batch has {unfinishedText(unfinished())}. </Show>Cancel is
          final. {finality}
        </p>
      </Show>
      {/* Outside the Shows a read switches, so a read withdrawing Cancel keeps its dialog. */}
      <ConfirmDialog
        controller={confirmCancel}
        heading={() => (
          <>
            Cancel the Batch <code class="job-address">{props.batch.id}</code>?
          </>
        )}
        confirm={() => "Cancel the Batch"}
        withdrawn={() =>
          props.batch.status === "cancelled"
            ? "The Batch is already cancelled."
            : props.batch.pendingControl
              ? "Cancel has already been asked."
              : undefined
        }
        act={async () => {
          await run("cancel");
          readAgain();
        }}
        notice={() => status}
      >
        {(counts) => (
          <>
            <p>
              <Show when={counts.unfinished}>
                {counts.unfinished === 1
                  ? "Its one unfinished job is cancelled at once if it is unsent or paused. Otherwise its Runner is asked to stop it. If it ends first, it keeps its status and output."
                  : `It has ${unfinishedText(counts.unfinished)}. Unsent and paused jobs are cancelled at once. Runners are asked to stop the others. Jobs that end first keep their status and output.`}{" "}
              </Show>
              {finality}
            </p>
            <Show when={counts.statusUnknown}>
              <p>
                {formatCount(counts.statusUnknown)} of its jobs{" "}
                {plural(counts.statusUnknown, "has", "have")} status unknown: the cancel waits until{" "}
                {counts.statusUnknown === 1
                  ? "its Runner reports or is"
                  : "their Runners report or are"}{" "}
                removed.
              </p>
            </Show>
          </>
        )}
      </ConfirmDialog>
    </>
  );
}
