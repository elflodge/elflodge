import { useQuery } from "@tanstack/solid-query";
import { Link } from "@tanstack/solid-router";
import {
  FAILURE_MESSAGE_MAX_LENGTH,
  FINAL_JOB_STATUSES,
  JOB_RESUMED,
  JOB_STARTED,
  type Job,
} from "contract";
import { For, Show, createMemo } from "solid-js";

import {
  DATE_TIME_SECONDS,
  TIME_SECONDS,
  USD_BUDGET,
  duration,
  formatCount,
  formatUsd,
} from "../format.ts";
import type { TimedEvent } from "../job-runs.ts";
import { orpc } from "../query.ts";
import { shortIds } from "../short-ids.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Instant, LastContact } from "./Instant.tsx";
import { JobSubmitter, RunnerOfJob } from "./JobReferences.tsx";
import { TextPreview } from "./TextPreview.tsx";

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
              <dd class="mono whole-id">{name()}</dd>
            </>
          )}
        </Show>
        <Show when={props.job.batchId}>
          {(batch) => (
            <>
              <dt>Batch</dt>
              <dd>
                <Link class="mono stands-alone" to="/batches/$id" params={{ id: batch() }}>
                  {batch()}
                </Link>{" "}
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
            <Show
              when={props.job.runner}
              fallback={
                props.job.startedAt ||
                (props.job.status === "failed" && props.job.failure.reason === "runnerRemoved")
                  ? "Removed"
                  : "None"
              }
            >
              {(runner) => (
                <>
                  <RunnerOfJob linked runner={runner()} shortId={runnerId() ?? runner().id} />
                  <span class="sub">
                    last seen <LastContact at={runner().lastSeenAt} readAt={props.readAt} />
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
              <dt>Last recorded report</dt>
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

export function JobLimits(props: { job: Job; resumeOffered: boolean; countFrom?: TimedEvent }) {
  const cost = () => props.job.usage.cost.totalUsd;
  const suffix = () =>
    !FINAL_JOB_STATUSES.includes(props.job.status) || props.resumeOffered ? " so far" : "";
  const measured = createMemo(() => {
    const start = props.countFrom;
    const report = props.job.lastReportedAt;
    if (!start || props.job.status !== "running" || !report) return undefined;
    // The Runner timestamps the opening Event. The hub timestamps receipt of the report.
    return { start, seconds: Math.max(0, (report.getTime() - start.at.getTime()) / 1000) };
  });
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
                  {USD_BUDGET.format(budget())} <span class="unit">USD</span>
                </p>
                <Show when={props.job.startedAt}>
                  <div class={["scale", { "is-over": cost() >= budget() }]}>
                    <meter
                      aria-label="Model budget used"
                      min={0}
                      max={budget()}
                      value={Math.min(cost(), budget())}
                      aria-valuetext={`${formatUsd(cost())} of ${USD_BUDGET.format(budget())} USD, estimated`}
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
                {formatUsd(cost())} <span class="unit">USD, est.</span>
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
              <Show when={measured()}>
                {(count) => (
                  <>
                    <div class="scale">
                      <meter
                        aria-label="Run timeout counted so far"
                        min={0}
                        max={limit()}
                        value={Math.min(count().seconds, limit())}
                        aria-valuetext={`about ${duration(count().seconds)} of ${duration(limit())} at the report`}
                      />
                    </div>
                    <dl>
                      <dt>Counted so far</dt>
                      <dd>about {duration(count().seconds)} at the report</dd>
                      <dt>Times out at about</dt>
                      <dd>
                        <Instant
                          value={new Date(count().start.at.getTime() + limit() * 1000)}
                          format={TIME_SECONDS}
                        />
                      </dd>
                    </dl>
                    <Show when={count().start.kind !== JOB_STARTED}>
                      <p class="note">
                        Counted from <Instant value={count().start.at} format={TIME_SECONDS} />
                        {count().start.kind === JOB_RESUMED
                          ? ", its resume."
                          : ", its Runner’s restart."}
                      </p>
                    </Show>
                  </>
                )}
              </Show>
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

export function JobOutputOrFailure(props: { text: string; failure?: boolean }) {
  const title = () => (props.failure ? "Failure message" : "Output");
  return (
    <section class="output-or-failure" aria-labelledby="output-or-failure">
      <div class="output-or-failure-head">
        <h2 id="output-or-failure">{title()}</h2>
        <Show when={!props.failure}>
          <CopyButton label="Copy Output" text={props.text} />
        </Show>
      </div>
      <Show when={props.failure && props.text.length === FAILURE_MESSAGE_MAX_LENGTH}>
        <p class="note">This message reached the maximum stored length.</p>
      </Show>
      <TextPreview
        id="output-or-failure-text"
        text={props.text}
        label={title()}
        wraps={props.failure}
        wholeTextLabel={props.failure ? "Show the whole message" : undefined}
      />
    </section>
  );
}
