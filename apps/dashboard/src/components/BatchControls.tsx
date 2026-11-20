import { useQueryClient } from "@tanstack/solid-query";
import type { Batch } from "contract";
import { Show, createSignal, flush } from "solid-js";

import { api, hubFailureMessage } from "../api-client.ts";
import { unfinishedJobs } from "../batch.ts";
import { focusIfLost } from "../form.ts";
import { formatCount, plural } from "../format.ts";
import { orpc } from "../query.ts";
import { BatchConditions, BatchStatus } from "./BatchStatus.tsx";
import { ConfirmAction } from "./ConfirmAction.tsx";
import { Notice } from "./Notice.tsx";

const finality = "It takes no new jobs, and none of its jobs can be resumed.";

export function BatchControls(props: { batch: Batch; canary: boolean }) {
  const client = useQueryClient();
  const [failure, setFailure] = createSignal<string>();
  const [pending, setPending] = createSignal(false);
  let status: HTMLDivElement | undefined;
  let alert: HTMLDivElement | undefined;
  function showFailure(message: string) {
    setFailure(message);
    flush();
    focusIfLost(alert);
  }
  async function act(control: "pause" | "resume" | "cancel", close?: () => boolean) {
    setPending(true);
    setFailure(undefined);
    const id = props.batch.id;
    const queryKey = orpc.batches.get.queryKey({ input: { id } });
    try {
      const batch = await api.batches[control]({ id });
      await client.cancelQueries({ queryKey, exact: true });
      const closed = close?.();
      client.setQueryData(queryKey, batch);
      flush();
      if (closed === false) focusIfLost(status);
      else status?.focus();
      void client.invalidateQueries({ queryKey: orpc.batches.list.key() });
      void client.invalidateQueries({ queryKey: orpc.jobs.list.key() });
      void client.invalidateQueries({ queryKey: orpc.jobs.counts.key() });
      void client.invalidateQueries({ queryKey: orpc.jobs.get.key() });
      return undefined;
    } catch (error) {
      return hubFailureMessage(error);
    } finally {
      setPending(false);
    }
  }
  async function press(control: "pause" | "resume") {
    const message = await act(control);
    if (message) showFailure(message);
  }
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
        <BatchConditions batch={props.batch} detailed canary={props.canary} />
        <Show when={props.batch.pendingControl || props.batch.status === "cancelled"}>
          <p class="note">{finality}</p>
        </Show>
        <Show when={pending()}>
          <p class="note">Working…</p>
        </Show>
      </div>
      <Show when={failure()}>
        {(message) => (
          <Notice
            role="alert"
            focusRef={(element) => {
              alert = element;
            }}
          >
            {message()}
          </Notice>
        )}
      </Show>
      <Show when={props.batch.status !== "cancelled"}>
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
          <Show when={props.batch.status === "paused"}>
            <button
              type="button"
              aria-describedby="resume-note"
              disabled={pending()}
              onClick={() => void press("resume")}
            >
              Resume
            </button>
          </Show>
          <Show
            when={!props.batch.pendingControl}
            fallback={
              <button type="button" class="danger" disabled aria-describedby="batch-status">
                Cancel
              </button>
            }
          >
            <ConfirmAction
              trigger="Cancel"
              triggerLabel={`Cancel the Batch ${props.batch.id}`}
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
              <p>
                <Show when={unfinished()}>
                  Its {unfinishedText()} {plural(unfinished(), "is", "are")} cancelled:{" "}
                  {unfinished() === 1
                    ? "at once if no Runner may be running it, otherwise once its Runner stops it"
                    : "those no Runner may be running at once, the others once their Runners stop them"}
                  .{" "}
                </Show>
                {finality}
              </p>
              <Show when={props.batch.statusUnknownJobs}>
                {(n) => (
                  <p>
                    {formatCount(n())} of its jobs {plural(n(), "has", "have")} status unknown: the
                    cancel waits until{" "}
                    {n() === 1 ? "its Runner reports or is" : "their Runners report or are"}{" "}
                    removed.
                  </p>
                )}
              </Show>
            </ConfirmAction>
          </Show>
        </div>
        <Show when={!props.batch.pendingControl}>
          <Show
            when={props.batch.status === "active"}
            fallback={
              <p class="note" id="resume-note">
                {resumeExplanation()}
                <Show when={props.batch.jobCounts.paused}>
                  {(n) => (
                    <>
                      {" "}
                      Its {formatCount(n())} paused {plural(n(), "job", "jobs")}{" "}
                      {plural(n(), "stays", "stay")} paused.
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
            {unfinished() ? `Cancel ends its ${unfinishedText()}. Final` : "Cancel is final"}: it
            takes no new jobs, and none of its jobs can be resumed.
          </p>
        </Show>
      </Show>
    </>
  );
}
