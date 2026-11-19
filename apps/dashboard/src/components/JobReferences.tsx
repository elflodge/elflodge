import { Link } from "@tanstack/solid-router";
import type { JobRunner, Submitter } from "contract";
import { Show } from "solid-js";

export function JobSubmitter(props: { submitter: Submitter; inList?: boolean }) {
  return (
    <>
      <span
        title={props.inList ? props.submitter.name || "Unnamed" : undefined}
        class={{
          mono: props.submitter.kind === "key" && !!props.submitter.name,
          unnamed: props.submitter.kind === "key" && !props.submitter.name,
        }}
      >
        {props.submitter.name || "Unnamed"}
      </span>{" "}
      <span class="unit">{props.submitter.kind}</span>
    </>
  );
}

/** The Runner a job was last sent to, and whether it is connected. */
export function RunnerOfJob(props: { runner: JobRunner; shortId: string; linked?: boolean }) {
  return (
    <span class="runner-ref">
      <Show
        when={props.linked}
        fallback={
          <span class="cut mono" title={props.runner.name}>
            {props.runner.name}
          </span>
        }
      >
        <Link class="mono stands-alone" to="/runners" hash={props.runner.id}>
          {props.runner.name}
        </Link>
      </Show>
      <span class="sid" title={props.runner.id}>
        {props.shortId}
      </span>
      <span
        class={["mark", props.runner.connected ? "mark-connected" : "mark-disconnected"]}
        aria-hidden="true"
      />
      <span class="vh">{props.runner.connected ? "connected" : "not connected"}</span>
    </span>
  );
}
