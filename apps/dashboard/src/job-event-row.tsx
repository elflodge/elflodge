import {
  JOB_CANCELLED,
  JOB_FAILED,
  JOB_PAUSED,
  JOB_RECOVERED,
  JOB_RESUMED,
  JOB_STARTED,
  JOB_SUCCEEDED,
} from "contract";
import { For, Show } from "solid-js";

import { Instant } from "./components/Instant.tsx";
import { TextPreview } from "./components/JobRecord.tsx";
import { FAILURE_WORDS } from "./components/JobStatus.tsx";
import { TIME_SECONDS, formatCount, formatUsd, plural } from "./format.ts";
import type { EventToolCall, ReadJobEvent } from "./job-event-record.ts";

const RUNNER_WORD = {
  [JOB_STARTED]: "Started",
  [JOB_RESUMED]: "Resumed",
  [JOB_RECOVERED]: "Recovered",
  [JOB_PAUSED]: "Paused",
  [JOB_FAILED]: "Failed",
  [JOB_SUCCEEDED]: "Succeeded",
  [JOB_CANCELLED]: "Cancelled",
};

interface RowProps {
  row: ReadJobEvent;
  userLabel?: "Input" | "Note at the resume";
  subAgent?: boolean;
  currentOutput?: boolean;
}

function countLines(text: string) {
  // As in the Output preview, count the displayed lines, including a final empty one.
  const count = text.split("\n").length;
  return `${formatCount(count)} ${plural(count, "line", "lines")}`;
}

function Call(props: { call: EventToolCall; previewId: string }) {
  const { name, id, arguments: args } = props.call;
  function argumentsBody() {
    if (name === "bash" && typeof args["command"] === "string") {
      return (
        <pre class="code wraps" tabindex="0" aria-label={`Command for ${id}`}>
          {args["command"]}
        </pre>
      );
    }
    if (
      name === "write" &&
      typeof args["path"] === "string" &&
      typeof args["content"] === "string"
    ) {
      return (
        <>
          <p>
            to <code>{args["path"]}</code>, {countLines(args["content"])}
          </p>
          <details>
            <summary>Show what it writes</summary>
            <pre class="code" tabindex="0" aria-label={`What ${id} writes`}>
              {args["content"]}
            </pre>
          </details>
        </>
      );
    }
    return (
      <TextPreview
        id={props.previewId}
        label={`Arguments of ${id}`}
        text={JSON.stringify(args, null, 2)}
      />
    );
  }
  return (
    <div class="call">
      <p>
        Tool call <b>{name}</b> <code>{id}</code>
      </p>
      {argumentsBody()}
    </div>
  );
}

type MessageContent =
  | string
  | ({ type: "text"; text: string } | { type: "image"; mimeType: string })[];

function messageText(content: MessageContent) {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : `An image, ${part.mimeType}`))
    .join("\n");
}

function agentStop(reason: string) {
  switch (reason) {
    case "stop":
      return "ending its turn";
    case "length":
      return "cut at the model’s output limit";
    case "error":
      return "Error";
    case "aborted":
      return "stopped";
    case "deferred":
      return "deferred";
    case "pending":
      return "pending";
    default:
      return "";
  }
}

function eventLabel({ row, userLabel }: RowProps) {
  const record = row.record;
  if (row.kind === "conversation" && row.relation) {
    const { owner, parent } = row.relation;
    const parts = [];
    if (owner) parts.push(`a sub-agent of conversation ${owner.conversationId}`);
    if (parent) parts.push(`a fork of conversation ${parent.conversationId} at Event ${parent.at}`);
    return `Conversation ${row.id} begins: ${parts.length ? parts.join(", ") : "the job’s own"}`;
  }
  switch (record?.kind) {
    case JOB_STARTED:
    case JOB_RESUMED:
    case JOB_RECOVERED:
    case JOB_PAUSED:
    case JOB_FAILED:
    case JOB_SUCCEEDED:
    case JOB_CANCELLED:
      return `Runner: ${RUNNER_WORD[record.kind]}`;
    case "pi.user":
      return userLabel ?? "Message to the agent";
    case "pi.assistant":
      return "Agent";
    case "pi.tool-result": {
      const [{ toolCallId, toolName }] = record.model;
      return `Tool result of ${toolCallId}, ${toolName}`;
    }
    case "pi.compaction":
      return `Compaction (${record.data.reason})`;
    case "pi.reset":
      return "Context reset";
    case "pi.system":
      return "The agent’s instructions or tools changed";
    default:
      return row.unreadable
        ? `The Event’s record could not be read: ${row.kind}`
        : `An Event of a kind this dashboard does not know: ${row.kind}`;
  }
}

function excerpt(text: string) {
  const first = text.trimStart().split("\n", 1)[0] ?? "";
  const limit = 96;
  return first.length > limit || first.length < text.trim().length
    ? `${first.slice(0, limit)}…`
    : first;
}

function summary(row: ReadJobEvent) {
  const record = row.record;
  switch (record?.kind) {
    case JOB_FAILED:
      return `, ${record.data.reason}`;
    case "pi.user":
    case "pi.compaction":
      return `: ${excerpt(messageText(record.model[0].content))}`;
    case "pi.tool-result": {
      const message = record.model[0];
      const body = messageText(message.content);
      return `: ${message.isError ? "Error, " : ""}${body.includes("\n") && !message.isError ? countLines(body) : excerpt(body)}`;
    }
    case "pi.assistant": {
      const message = record.model[0];
      const pieces = message.content.flatMap((part) => {
        if (part.type === "text") return [excerpt(part.text)];
        if (part.type === "toolCall") return [`calls ${part.name} ${part.id}`];
        return [];
      });
      pieces.push(agentStop(message.stopReason));
      if (message.errorMessage) pieces.push(excerpt(message.errorMessage));
      return `: ${pieces.filter(Boolean).join(" ")}`;
    }
    default:
      return "";
  }
}

function EventBody(props: RowProps) {
  const fullText = (text: string, label: string, wraps = true) => (
    <TextPreview id={`event-${props.row.id}-text`} text={text} label={label} wraps={wraps} />
  );
  function body() {
    const record = props.row.record;
    switch (record?.kind) {
      case JOB_STARTED:
      case JOB_RESUMED:
      case JOB_RECOVERED:
        return (
          <p class="rec">
            run <code title={record.data.runId}>{record.data.runId.slice(0, 8)}</code> on a Runner
            at version {record.data.runnerVersion}
          </p>
        );
      case JOB_PAUSED:
      case JOB_CANCELLED:
        return undefined;
      case JOB_FAILED:
        return (
          <div class="rec">
            <code>{record.data.reason}</code> — {FAILURE_WORDS[record.data.reason]}
            {record.data.message && fullText(record.data.message, "Failure message")}
          </div>
        );
      case JOB_SUCCEEDED:
        return (
          <Show
            when={props.currentOutput}
            fallback={fullText(JSON.stringify(record.data.output, null, 2), "Output", false)}
          >
            with its <a href="#output-or-failure">Output</a>
          </Show>
        );
      case "pi.user":
      case "pi.compaction":
        return <p class="say">{messageText(record.model[0].content)}</p>;
      case "pi.reset":
        return record.model && <p class="say">{messageText(record.model[0].content)}</p>;
      case "pi.system":
        return undefined;
      case "pi.tool-result": {
        const message = record.model[0];
        const text = messageText(message.content);
        return (
          <div class="result">
            <p>
              {message.isError && <b>Error. </b>}
              {countLines(text)}
            </p>
            {fullText(
              text,
              `Result of ${message.toolCallId}`,
              message.isError || !text.includes("\n"),
            )}
          </div>
        );
      }
      case "pi.assistant": {
        const message = record.model[0];
        return (
          <>
            <For each={message.content}>
              {(part, index) => {
                switch (part.type) {
                  case "text":
                    return <p class="say">{part.text}</p>;
                  case "thinking":
                    return (
                      <details>
                        <summary>Show its thinking</summary>
                        <p class="say">
                          {part.redacted ? "The provider withheld its thinking." : part.thinking}
                        </p>
                      </details>
                    );
                }
                return <Call call={part} previewId={`event-${props.row.id}-call-${index()}`} />;
              }}
            </For>
            <Show when={agentStop(message.stopReason)}>{(stop) => <p>{stop()}</p>}</Show>
            {message.errorMessage && fullText(message.errorMessage, "Agent error")}
          </>
        );
      }
      default:
        return props.row.kind === "conversation" && props.row.relation
          ? undefined
          : fullText(JSON.stringify(props.row.event, null, 2), "Whole Event", false);
    }
  }
  return (
    <div class="ev-body">
      <strong>
        <Show when={props.row.isError}>
          <span class="mark mark-failed" aria-hidden="true" />{" "}
        </Show>
        {props.subAgent && "Sub-agent: "}
        {eventLabel(props)}
      </strong>
      {body()}
    </div>
  );
}

export function JobEventRow(props: RowProps) {
  const assistant = () =>
    props.row.record?.kind === "pi.assistant" ? props.row.record.model[0] : undefined;
  return (
    <li
      class={[
        "ev",
        {
          "is-runner": props.row.runner,
          "is-error": props.row.isError,
          "conv-sub": !!props.subAgent,
        },
      ]}
    >
      <a
        class="ev-id stands-alone"
        id={`event-${props.row.id}`}
        href={`#event-${props.row.id}`}
        aria-label={`Event ${props.row.id}`}
      >
        {props.row.id}
      </a>
      <span class="ev-time">
        <Show when={props.row.at}>{(at) => <Instant value={at()} format={TIME_SECONDS} />}</Show>
      </span>
      <p class="ev-line">
        <Show when={props.row.isError}>
          <span class="mark mark-failed" aria-hidden="true" />{" "}
        </Show>
        {props.subAgent && "Sub-agent: "}
        {eventLabel(props)}
        {summary(props.row)}
      </p>
      <EventBody {...props} />
      <Show when={assistant()}>
        {(message) => (
          <div class="ev-rail">
            <span>
              {formatUsd(message().usage.cost.total, 6)} <span class="unit">USD, est.</span>
            </span>
            <span>
              {formatCount(message().usage.totalTokens)} <span class="unit">tokens</span>
            </span>
            <code>{props.row.providerModel}</code>
          </div>
        )}
      </Show>
    </li>
  );
}
