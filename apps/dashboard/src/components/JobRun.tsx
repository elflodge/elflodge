import { JOB_PAUSED, JOB_RESUMED, type Job } from "contract";
import { Show } from "solid-js";

import { DATE_TIME_SECONDS, TIME_SECONDS, duration, formatCount } from "../format.ts";
import type { LoadedRun, TimedEvent } from "../job-runs.ts";
import { Instant } from "./Instant.tsx";

function time(at: Date) {
  return <Instant value={at} format={TIME_SECONDS} />;
}

function between(from: Date, to: Date) {
  return duration((to.getTime() - from.getTime()) / 1000);
}

function wordsBetween(ended: TimedEvent, resumed: TimedEvent, form: "gap" | "after") {
  const parts = ended.lifecycle[form]?.(ended.at, resumed.at, between(ended.at, resumed.at));
  return parts?.map((part) => (typeof part === "string" ? part : time(part)));
}

export function RunHeading(props: { run: LoadedRun; running: boolean; shortRunId?: string }) {
  const opening = () => props.run.opening;
  return (
    <>
      <Show when={opening().kind === JOB_RESUMED && props.run.previousEnd}>
        {(end) => (
          <li class="run-gap" tabindex="-1">
            {wordsBetween(end(), opening(), "gap")}
          </li>
        )}
      </Show>
      <li class="run-h" tabindex="-1">
        <h3>
          {opening().lifecycle.runHeading}{" "}
          <Instant value={opening().at} format={DATE_TIME_SECONDS} />
        </h3>
        <Show when={props.run.end} fallback={props.running && <span>still running</span>}>
          {(end) => (
            <span>
              to {time(end().at)}, {between(opening().at, end().at)}
            </span>
          )}
        </Show>
        <span class="sid" title={opening().runId}>
          run {props.shortRunId}
        </span>
        <span class="mono">{[...props.run.models].join(", ")}</span>
      </li>
    </>
  );
}

export function RunSentence(props: { run: LoadedRun; job: Job }) {
  const opening = () => props.run.opening;
  const recovered = () => props.run.recoveries.at(-1);
  return (
    <Show
      when={
        (props.job.status === "running" && !props.job.statusUnknown && !props.run.end) ||
        (props.job.status === "paused" && props.run.end?.kind === JOB_PAUSED)
      }
    >
      <p class="head-sentence">
        <Show
          when={props.run.end}
          fallback={
            <>
              {opening().lifecycle.since} {time(opening().at)}
              <Show when={opening().kind === JOB_RESUMED && props.run.previousEnd}>
                {(end) => wordsBetween(end(), opening(), "after")}
              </Show>
              .
            </>
          }
        >
          {(end) => (
            <>
              {end().lifecycle.label} {time(end().at)}, {between(opening().at, end().at)} into its
              run.
            </>
          )}
        </Show>
        <Show when={recovered()}>
          {(last) => (
            <>
              {" "}
              {last().lifecycle.label}{" "}
              {props.run.recoveries.length === 1
                ? "once, at"
                : `${formatCount(props.run.recoveries.length)} times, most recently at`}{" "}
              {time(last().at)}, when its Runner restarted.
            </>
          )}
        </Show>
      </p>
    </Show>
  );
}
