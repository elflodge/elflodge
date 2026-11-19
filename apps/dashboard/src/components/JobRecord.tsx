import { useQuery } from "@tanstack/solid-query";
import { Link } from "@tanstack/solid-router";
import { FAILURE_MESSAGE_MAX_LENGTH, type Job } from "contract";
import { For, Show, createMemo, createSignal, flush, onSettled } from "solid-js";

import {
  DATE_TIME_SECONDS,
  TIME_SECONDS,
  duration,
  elapsedSince,
  formatCount,
  formatJobUsd,
} from "../format.ts";
import { orpc } from "../query.ts";
import { shortIds } from "../short-ids.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Instant } from "./Instant.tsx";
import { JobSubmitter, RunnerOfJob } from "./JobReferences.tsx";

export function JobFacts(props: { job: Job; readAt: number }) {
  const runners = useQuery(() => orpc.runners.list.queryOptions());
  const runnerId = createMemo(() => {
    const id = props.job.runner?.id;
    if (!id) return undefined;
    const listed = runners.dataUpdatedAt ? runners.data.map((runner) => runner.id) : [];
    return shortIds([...listed, id]).get(id);
  });
  return (
    <aside class="facts-aside" aria-labelledby="job-facts">
      <h2 id="job-facts">The job</h2>
      <dl>
        <dt>ID</dt>
        <dd class="mono selectable">{props.job.id}</dd>
        <Show when={props.job.customId}>
          {(name) => (
            <>
              <dt>Custom ID</dt>
              <dd class="mono">{name()}</dd>
            </>
          )}
        </Show>
        <Show when={props.job.batchId}>
          {(batch) => (
            <>
              <dt>Batch</dt>
              <dd>
                <span class="mono">{batch()}</span>{" "}
                <Link class="stands-alone" to="/jobs" search={{ batchId: batch() }}>
                  its jobs
                </Link>
              </dd>
            </>
          )}
        </Show>
        <Show when={props.job.submitter}>
          {(sender) => (
            <>
              <dt>Submitter</dt>
              <dd>
                <JobSubmitter submitter={sender()} />
              </dd>
            </>
          )}
        </Show>
        <Show when={props.job.labels && Object.keys(props.job.labels).length}>
          <dt>Labels</dt>
          <dd>
            <ul class="labels">
              <For each={Object.entries(props.job.labels ?? {})}>
                {(entry) => (
                  <li>
                    <span class="lk">{entry[0]}</span>
                    <span class="leq">=</span>
                    {entry[1]}
                  </li>
                )}
              </For>
            </ul>
          </dd>
        </Show>
        <Show when={!props.job.deletedAt}>
          <dt>Runner</dt>
          <dd>
            <Show when={props.job.runner} fallback={props.job.startedAt ? "Removed" : "None yet"}>
              {(runner) => (
                <>
                  <RunnerOfJob linked runner={runner()} shortId={runnerId() ?? runner().id} />
                  <span class="sub">
                    last seen {elapsedSince(runner().lastSeenAt, props.readAt)}, at{" "}
                    <Instant value={runner().lastSeenAt} format={TIME_SECONDS} />
                  </span>
                </>
              )}
            </Show>
          </dd>
        </Show>
        <dt>Created</dt>
        <dd>
          <Instant value={props.job.createdAt} format={DATE_TIME_SECONDS} />
        </dd>
        <Show when={props.job.startedAt}>
          {(at) => (
            <>
              <dt>Started</dt>
              <dd>
                <Instant value={at()} format={DATE_TIME_SECONDS} />
              </dd>
            </>
          )}
        </Show>
        <Show when={props.job.endedAt}>
          {(at) => (
            <>
              <dt>Ended</dt>
              <dd>
                <Instant value={at()} format={DATE_TIME_SECONDS} />
              </dd>
            </>
          )}
        </Show>
        <Show when={props.job.lastReportedAt}>
          {(at) => (
            <>
              <dt>Last report</dt>
              <dd>
                <Instant value={at()} format={DATE_TIME_SECONDS} />
              </dd>
            </>
          )}
        </Show>
        <Show when={props.job.deletedAt}>
          {(at) => (
            <>
              <dt>Deleted</dt>
              <dd>
                <Instant value={at()} format={DATE_TIME_SECONDS} />
              </dd>
            </>
          )}
        </Show>
      </dl>
    </aside>
  );
}

export function JobLimits(props: { job: Job; resumeOffered: boolean }) {
  const cost = () => props.job.usage.cost.totalUsd;
  const suffix = () =>
    (!props.job.deletedAt &&
      (props.job.status === "queued" ||
        props.job.status === "running" ||
        props.job.status === "paused")) ||
    props.resumeOffered
      ? " so far"
      : "";
  return (
    <section aria-labelledby="job-limits">
      <h2 id="job-limits">
        {props.job.deletedAt ? "Usage" : props.job.startedAt ? "Limits and usage" : "Limits"}
      </h2>
      <div class="limits">
        <div class="limit">
          <Show when={props.job.modelBudgetUsd}>
            {(budget) => (
              <>
                <h3>
                  Model budget <span class="unit">over its life</span>
                </h3>
                <p class="limit-value">
                  {formatJobUsd(budget(), "budget")} <span class="unit">USD</span>
                </p>
                <Show when={props.job.startedAt}>
                  <div class={["scale", { "is-over": cost() >= budget() }]}>
                    <meter
                      aria-label="Model budget used"
                      min={0}
                      max={budget()}
                      value={Math.min(cost(), budget())}
                      aria-valuetext={`${formatJobUsd(cost(), "cost")} of ${formatJobUsd(budget(), "budget")} USD, estimated`}
                    />
                  </div>
                </Show>
              </>
            )}
          </Show>
          <Show when={props.job.startedAt}>
            <dl>
              <dt>Cost{suffix()}</dt>
              <dd>
                {formatJobUsd(cost(), "cost")} <span class="unit">USD, est.</span>
              </dd>
              <dt>Tokens{suffix()}</dt>
              <dd>{formatCount(props.job.usage.totalTokens)}</dd>
            </dl>
          </Show>
        </div>
        <Show when={props.job.runTimeoutSeconds}>
          {(limit) => (
            <div class="limit">
              <h3>
                Run timeout <span class="unit">each run</span>
              </h3>
              <p class="limit-value">{duration(limit())}</p>
              <Show
                when={
                  props.job.startedAt &&
                  props.job.status === "failed" &&
                  props.job.failure.reason === "runTimedOut"
                }
              >
                <div class="scale is-over">
                  <meter
                    aria-label="Run timeout reached"
                    min={0}
                    max={limit()}
                    value={limit()}
                    aria-valuetext="Run timeout reached"
                  />
                </div>
              </Show>
            </div>
          )}
        </Show>
      </div>
    </section>
  );
}

export function JobResult(props: { text: string; failure?: boolean }) {
  const lines = createMemo(() => props.text.split("\n").length);
  const [long, setLong] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const title = () => (props.failure ? "Failure message" : "Output");
  return (
    <section class="job-result" aria-labelledby="job-result">
      <div class="result-head">
        <h2 id="job-result">{title()}</h2>
        <Show when={!props.failure}>
          <CopyButton label="Copy Output" text={props.text} />
        </Show>
      </div>
      <Show when={props.failure && props.text.length === FAILURE_MESSAGE_MAX_LENGTH}>
        <p class="note">
          {formatCount(FAILURE_MESSAGE_MAX_LENGTH)} characters, the most the hub keeps.
        </p>
      </Show>
      <pre
        id="job-result-text"
        class={["code", "res-preview", { wraps: !!props.failure }]}
        tabindex="0"
        aria-label={title()}
      >
        <code
          ref={(element) => {
            // A single line of a failure can wrap beyond the preview when the page narrows.
            onSettled(() => {
              const observer = new ResizeObserver(() => {
                const style = getComputedStyle(element);
                const previewLines = Number(style.getPropertyValue("--job-preview-lines"));
                setLong(element.offsetHeight > previewLines * parseFloat(style.lineHeight) + 1);
              });
              observer.observe(element);
              return () => observer.disconnect();
            });
          }}
        >
          {props.text}
        </code>
      </pre>
      <Show when={long()}>
        <button
          type="button"
          aria-controls="job-result-text"
          aria-expanded={expanded() ? "true" : "false"}
          onClick={(event) => {
            setExpanded(!expanded());
            if (!expanded()) {
              flush();
              event.currentTarget.scrollIntoView({ block: "nearest" });
            }
          }}
        >
          {expanded()
            ? "Show the first lines only"
            : props.failure
              ? "Show the whole message"
              : `Show all ${formatCount(lines())} lines`}
        </button>
      </Show>
    </section>
  );
}
