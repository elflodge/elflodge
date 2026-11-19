import type { Job } from "contract";
import { For, Show } from "solid-js";

import { TIME_SECONDS, duration } from "../format.ts";
import { Instant } from "./Instant.tsx";

function AtReport(props: { changedAt: string; report: Date }) {
  const start = () => new Date(props.changedAt);
  return (
    <span class="sub">
      since <Instant value={start()} format={TIME_SECONDS} />,{" "}
      {duration((props.report.getTime() - start().getTime()) / 1000)} at the report
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

export function JobActivity(props: { job: Job; readAt: number }) {
  return (
    <section class="activity" aria-labelledby="job-activity">
      <h2 id="job-activity">Current activity</h2>
      <Show when={props.job.lastReportedAt} fallback={<p>No report yet from this run.</p>}>
        {(report) => (
          <>
            <p class="note">
              As of report <Instant value={report()} format={TIME_SECONDS} />,{" "}
              {duration((props.readAt - report().getTime()) / 1000)} before this read.
            </p>
            <Show when={props.job.activity} fallback={<p>No activity in the report.</p>}>
              {(activity) => (
                <For
                  keyed={(part) => part.conversationId}
                  each={activity()}
                  fallback={<p>Between steps at the report.</p>}
                >
                  {(conversation) => (
                    <div>
                      <h3>Conversation {conversation().conversationId}</h3>
                      <ul class="plain">
                        <Show when={conversation().generation}>
                          {(call) => (
                            <li>
                              Model call, attempt {call().attempt}
                              <Show when={call().retry}>
                                {(retry) => <Retry retry={retry()} />}
                              </Show>
                              <AtReport changedAt={call().changedAt} report={report()} />
                            </li>
                          )}
                        </Show>
                        <For keyed={(tool) => tool.callId} each={conversation().tools}>
                          {(tool) => (
                            <li>
                              Tool <code>{tool().name}</code>{" "}
                              {tool().status === "pending" ? "waiting" : "running"}{" "}
                              <span class="sid">{tool().callId}</span>
                              <AtReport changedAt={tool().changedAt} report={report()} />
                            </li>
                          )}
                        </For>
                        <For each={conversation().compactions}>
                          {(step) => (
                            <li>
                              Compaction ({step.reason}), attempt {step.attempt}
                              {step.blocking && ", the model call waits for it"}
                              <Show when={step.retry}>{(retry) => <Retry retry={retry()} />}</Show>
                              <AtReport changedAt={step.changedAt} report={report()} />
                            </li>
                          )}
                        </For>
                      </ul>
                    </div>
                  )}
                </For>
              )}
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
