import { JOB_PAUSED, JOB_RESUMED, type Job } from "contract";
import { Show } from "solid-js";

import { DATE_TIME_SECONDS, TIME_SECONDS, duration, formatCount } from "../format.ts";
import type { LoadedRun } from "../job-runs.ts";
import { Instant } from "./Instant.tsx";

// A run and its ends are built anew on each read of the Events, so the Shows here read them
// directly, guarding for an end that is gone, rather than through the Show's accessor (AGENTS.md).

function between(from: Date | undefined, to: Date | undefined) {
  return from && to ? duration((to.getTime() - from.getTime()) / 1000) : "";
}

export function RunHeading(props: { run: LoadedRun; running: boolean; shortRunId?: string }) {
  const opening = () => props.run.opening;
  return (
    <>
      <Show when={opening().kind === JOB_RESUMED && props.run.previousEnd}>
        <li class="run-gap" tabindex="-1">
          {props.run.previousEnd?.lifecycle.label}{" "}
          <Instant value={props.run.previousEnd?.at} format={DATE_TIME_SECONDS} />.{" "}
          {opening().lifecycle.label} <Instant value={opening().at} format={DATE_TIME_SECONDS} />.
        </li>
      </Show>
      <li class="run-h" tabindex="-1">
        <h3>
          {opening().lifecycle.runHeading}{" "}
          <Instant value={opening().at} format={DATE_TIME_SECONDS} />
        </h3>
        <Show when={props.run.end} fallback={props.running && <span>still running</span>}>
          <span>
            to <Instant value={props.run.end?.at} format={TIME_SECONDS} />,{" "}
            {between(opening().at, props.run.end?.at)}
          </span>
        </Show>
        <span class="sid" title={opening().runId}>
          run {props.shortRunId}
        </span>
        <span class="mono">{[...props.run.models].join(", ")}</span>
      </li>
    </>
  );
}

/** The run in the page's head sentence. It is missing only while the head's Show takes this away. */
export function RunSentence(props: { run: LoadedRun | undefined; status: Job["status"] }) {
  const opening = () => props.run?.opening;
  const end = () => props.run?.end;
  const recoveries = () => props.run?.recoveries.length ?? 0;
  const recovered = () => props.run?.recoveries.at(-1);
  const previousEnd = () => (opening()?.kind === JOB_RESUMED ? props.run?.previousEnd : undefined);
  return (
    <Show
      when={
        (props.status === "running" && props.run && !props.run.end) ||
        (props.status === "paused" && props.run?.end?.kind === JOB_PAUSED)
      }
    >
      <p class="head-sentence">
        <Show
          when={end()}
          fallback={
            <>
              {opening()?.lifecycle.since}{" "}
              <Instant
                value={opening()?.at}
                format={previousEnd() ? DATE_TIME_SECONDS : TIME_SECONDS}
              />
              .
              <Show when={previousEnd()}>
                {" "}
                Previously {previousEnd()?.lifecycle.label.toLowerCase()}{" "}
                <Instant value={previousEnd()?.at} format={DATE_TIME_SECONDS} />.
              </Show>
            </>
          }
        >
          {end()?.lifecycle.label} <Instant value={end()?.at} format={TIME_SECONDS} />,{" "}
          {between(opening()?.at, end()?.at)} into its run.
        </Show>
        <Show when={recovered()}>
          {" "}
          {recovered()?.lifecycle.label}{" "}
          {recoveries() === 1 ? "once, at" : `${formatCount(recoveries())} times, most recently at`}{" "}
          <Instant value={recovered()?.at} format={TIME_SECONDS} />, when its Runner restarted.
        </Show>
      </p>
    </Show>
  );
}
