import {
  JOB_CANCELLED,
  JOB_FAILED,
  JOB_PAUSED,
  JOB_RESUMED,
  JOB_STARTED,
  JOB_SUCCEEDED,
  type Job,
} from "contract";
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

export function RunHeading(props: { run: LoadedRun; running: boolean }) {
  const opening = () => props.run.opening;
  return (
    <>
      <Show when={opening().kind === JOB_RESUMED && props.run.previousEnd}>
        {(end) => (
          <li class="run-gap">
            {end().kind === JOB_PAUSED ? (
              <>
                Paused for {between(end().at, opening().at)}, {time(end().at)} to{" "}
                {time(opening().at)}
              </>
            ) : (
              <>
                {end().kind === JOB_CANCELLED
                  ? "Cancelled"
                  : end().kind === JOB_SUCCEEDED
                    ? "Succeeded"
                    : "Failed"}{" "}
                {time(end().at)}, resumed {time(opening().at)}
              </>
            )}
          </li>
        )}
      </Show>
      <li class="run-h">
        <h3>
          Run {opening().kind === JOB_STARTED ? "started" : "resumed"}{" "}
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
          run {opening().runId?.slice(0, 8)}
        </span>
        <span class="mono">{[...props.run.models].join(", ")}</span>
      </li>
    </>
  );
}

function previousStop(stop: TimedEvent, opening: TimedEvent) {
  if (stop.kind === JOB_PAUSED) return <>, after a pause of {between(stop.at, opening.at)}</>;
  if (stop.kind === JOB_FAILED) return <>, after it failed at {time(stop.at)}</>;
  if (stop.kind === JOB_CANCELLED) return <>, after it was cancelled at {time(stop.at)}</>;
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
                Resumed {time(opening().at)}
                <Show when={props.run.previousEnd}>{(end) => previousStop(end(), opening())}</Show>.
              </>
            ) : (
              <>Running since {time(opening().at)}.</>
            )
          }
        >
          {(end) => (
            <>
              Paused {time(end().at)}, {between(opening().at, end().at)} into its run.
            </>
          )}
        </Show>
        <Show when={recovered()}>
          {(last) => (
            <>
              {" "}
              Recovered{" "}
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
