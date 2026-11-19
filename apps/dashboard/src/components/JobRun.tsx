import { JOB_CANCELLED, JOB_FAILED, JOB_PAUSED, JOB_RESUMED, type Job } from "contract";
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

export function RunHeading(props: { run: LoadedRun; running: boolean; shortRunId?: string }) {
  const opening = () => props.run.opening;
  return (
    <>
      <Show when={opening().kind === JOB_RESUMED && props.run.previousEnd}>
        {(end) => (
          <li class="run-gap">
            {end().kind === JOB_PAUSED ? (
              <>
                {end().lifecycleWord} for {between(end().at, opening().at)}, {time(end().at)} to{" "}
                {time(opening().at)}
              </>
            ) : (
              <>
                {end().lifecycleWord} {time(end().at)}; {opening().lifecycleWord.toLowerCase()}{" "}
                {time(opening().at)}
              </>
            )}
          </li>
        )}
      </Show>
      <li class="run-h">
        <h3>
          Run {opening().lifecycleWord.toLowerCase()}{" "}
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

function previousStop(stop: TimedEvent, opening: TimedEvent) {
  if (stop.kind === JOB_PAUSED) return <>, after a pause of {between(stop.at, opening.at)}</>;
  if (stop.kind === JOB_FAILED || stop.kind === JOB_CANCELLED) {
    return (
      <>
        , after it {stop.kind === JOB_CANCELLED && "was "}
        {stop.lifecycleWord.toLowerCase()} at {time(stop.at)}
      </>
    );
  }
  return null;
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
            opening().kind === JOB_RESUMED ? (
              <>
                {opening().lifecycleWord} {time(opening().at)}
                <Show when={props.run.previousEnd}>{(end) => previousStop(end(), opening())}</Show>.
              </>
            ) : (
              <>Running since {time(opening().at)}.</>
            )
          }
        >
          {(end) => (
            <>
              {end().lifecycleWord} {time(end().at)}, {between(opening().at, end().at)} into its
              run.
            </>
          )}
        </Show>
        <Show when={recovered()}>
          {(last) => (
            <>
              {" "}
              {last().lifecycleWord}{" "}
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
