import { dynamic } from "@solidjs/web";
import type { Job } from "contract";
import { For, Show } from "solid-js";

import { TIME_SECONDS } from "../format.ts";
import { Instant } from "./Instant.tsx";

function ObservedChange(props: { changedAt: string }) {
  return (
    <span class="sub">
      Runner saw this change at <Instant value={new Date(props.changedAt)} format={TIME_SECONDS} />.
    </span>
  );
}

function Retry(props: { retry: { at: string; error: string } }) {
  return (
    <>
      {" "}
      failed. It tries again at <Instant value={new Date(props.retry.at)} format={TIME_SECONDS} />.
      <span class="sub">{props.retry.error}</span>
    </>
  );
}

export function JobActivity(props: { job: Job; atEnd?: boolean }) {
  const Heading = dynamic(() => (props.atEnd ? "h3" : "h2"));
  const ConversationHeading = dynamic(() => (props.atEnd ? "h4" : "h3"));
  return (
    <section class="activity" aria-labelledby={props.atEnd ? "latest-activity" : "job-activity"}>
      <Heading id={props.atEnd ? "latest-activity" : "job-activity"}>
        {props.atEnd && <span class="mark mark-running" aria-hidden="true" />} Latest activity
      </Heading>
      <Show when={props.job.lastReportedAt} fallback={<p>No report recorded yet for this run.</p>}>
        <Show when={props.job.activity} fallback={<p>No activity has been reported.</p>}>
          {(activity) => (
            <For
              keyed={(part) => part.conversationId}
              each={activity()}
              fallback={<p>Between steps when last observed.</p>}
            >
              {(conversation) => (
                <div>
                  <ConversationHeading>
                    Conversation {conversation().conversationId}
                  </ConversationHeading>
                  <ul class="plain">
                    <Show when={conversation().generation}>
                      {(call) => (
                        <li>
                          Model call, attempt {call().attempt}
                          <Show when={call().retry}>{(retry) => <Retry retry={retry()} />}</Show>
                          <ObservedChange changedAt={call().changedAt} />
                        </li>
                      )}
                    </Show>
                    <For keyed={(tool) => tool.callId} each={conversation().tools}>
                      {(tool) => (
                        <li>
                          Tool <code>{tool().name}</code>{" "}
                          {tool().status === "pending" ? "waiting" : "running"}{" "}
                          <span class="sid">{tool().callId}</span>
                          <ObservedChange changedAt={tool().changedAt} />
                        </li>
                      )}
                    </For>
                    <For each={conversation().compactions}>
                      {(step) => (
                        <li>
                          Compaction ({step.reason}), attempt {step.attempt}
                          {step.blocking && ", the model call waits for it"}
                          <Show when={step.retry}>{(retry) => <Retry retry={retry()} />}</Show>
                          <ObservedChange changedAt={step.changedAt} />
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              )}
            </For>
          )}
        </Show>
      </Show>
    </section>
  );
}
