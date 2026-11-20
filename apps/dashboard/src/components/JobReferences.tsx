import { Link } from "@tanstack/solid-router";
import type { Submitter } from "contract";
import { Show } from "solid-js";

export function submitterName(submitter: Submitter) {
  return submitter.name || "Unnamed";
}

export function JobSubmitter(props: { submitter: Submitter; inList?: boolean }) {
  return (
    <>
      <span
        title={props.inList ? submitterName(props.submitter) : undefined}
        class={{
          mono: props.submitter.kind === "key" && !!props.submitter.name,
          unnamed: props.submitter.kind === "key" && !props.submitter.name,
        }}
      >
        {submitterName(props.submitter)}
      </span>{" "}
      <span class="unit">{props.submitter.kind}</span>
    </>
  );
}

/** A Runner's name and short ID, with its connection state when the read gives one. */
export function RunnerReference(props: {
  runner: { id: string; name?: string | undefined; connected?: boolean };
  shortId: string;
  linked?: boolean;
}) {
  return (
    <span class="runner-ref">
      <Show when={props.runner.name !== undefined} fallback="A Runner since removed">
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
      </Show>
      <span class="sid" title={props.runner.id}>
        {props.shortId}
      </span>
      <Show when={props.runner.connected !== undefined}>
        <span
          class={["mark", props.runner.connected ? "mark-connected" : "mark-disconnected"]}
          aria-hidden="true"
        />
        <span class="vh">{props.runner.connected ? "connected" : "not connected"}</span>
      </Show>
    </span>
  );
}
