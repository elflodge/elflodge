import type { JSX } from "@solidjs/web";
import type { UsageGroup, UsageGroupBy, UsageReport } from "contract";
import { For, Repeat, Show, createMemo } from "solid-js";

import { formatCount, formatUsd, plural, UTC_DAY, UTC_WEEKDAY } from "../format.ts";
import { shortIds } from "../short-ids.ts";
import { JobSubmitter } from "./JobReferences.tsx";
import { STATUS_WORDS } from "./JobStatus.tsx";

type Figures = Pick<UsageReport, "jobEnds" | "usage">;

const grouping = {
  batch: { heading: "By Batch", column: "Batch", one: "Batch", many: "Batches" },
  submitter: { heading: "By submitter", column: "Submitter", one: "submitter", many: "submitters" },
  runner: { heading: "By Runner", column: "Runner", one: "Runner", many: "Runners" },
  status: { heading: "By status", column: "Status", one: "status", many: "statuses" },
  label: { heading: "By the Label", column: "Value of", one: "value", many: "values" },
} as const;

function groupName(
  group: UsageGroup,
  groups: UsageGroup[],
  ids: Map<string, string>,
  label?: string,
) {
  if ("batchId" in group) return <span class="mono">{group.batchId}</span>;
  if ("status" in group)
    return (
      <span class={["status-word", `s-${group.status}`]}>
        <span aria-hidden="true" class={["mark", `mark-${group.status}`]} />
        {STATUS_WORDS[group.status]}
      </span>
    );
  if ("labelValue" in group)
    return group.labelValue === null ? (
      <>
        Jobs without the Label <code>{label}</code>
      </>
    ) : (
      <code>
        <span class="lk">{label}</span> <span class="leq">=</span>{" "}
        {group.labelValue === "" ? '""' : group.labelValue}
      </code>
    );
  if ("runner" in group)
    return group.runner === null ? (
      "No Runner: ended before one started them"
    ) : (
      <>
        {group.runner.name === undefined ? (
          "A Runner since removed"
        ) : (
          <span class="mono">{group.runner.name}</span>
        )}{" "}
        <span class="sid" title={group.runner.id}>
          {ids.get(group.runner.id)}
        </span>
      </>
    );
  const submitter = group.submitter;
  return (
    <>
      <JobSubmitter submitter={submitter} />{" "}
      <Show
        when={groups.some(
          (other) =>
            "submitter" in other &&
            other.submitter.id !== submitter.id &&
            (other.submitter.name ?? "Unnamed") === (submitter.name ?? "Unnamed"),
        )}
      >
        <span class="sid" title={submitter.id}>
          {ids.get(submitter.id)}
        </span>
      </Show>
    </>
  );
}

function FigureCells(props: { figures: Figures; largest?: number; today?: boolean }) {
  return (
    <>
      <td class="num">{formatCount(props.figures.jobEnds)}</td>
      <td class="num">{formatCount(props.figures.usage.totalTokens)}</td>
      <td class="num">{formatUsd(props.figures.usage.cost.totalUsd)}</td>
      <td class="bar-cell">
        <Show when={props.largest !== undefined && props.figures.usage.cost.totalUsd > 0}>
          <meter
            min={0}
            max={props.largest}
            value={props.figures.usage.cost.totalUsd}
            class={{ "is-filling": props.today }}
            aria-label="Cost against the largest row"
          />
        </Show>
      </td>
    </>
  );
}

function Ledger(props: {
  id: string;
  heading: JSX.Element;
  column: JSX.Element;
  footer: string;
  total?: Figures;
  children: JSX.Element;
}) {
  return (
    <section>
      <h2 id={props.id}>{props.heading}</h2>
      <table class="ledger" aria-labelledby={props.id} aria-busy={props.total ? undefined : "true"}>
        <thead>
          <tr>
            <th scope="col">{props.column}</th>
            <th scope="col" class="num">
              Job ends
            </th>
            <th scope="col" class="num">
              Tokens
            </th>
            <th scope="col" class="num">
              Cost <span class="unit">USD, est.</span>
            </th>
            <th scope="col" class="bar-cell">
              <span class="vh">Cost, as a bar against the largest row</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <Show
            when={props.total}
            fallback={
              <Repeat count={5}>
                {() => (
                  <tr aria-hidden="true">
                    <td colspan={5}>
                      <span class="sk" />
                    </td>
                  </tr>
                )}
              </Repeat>
            }
          >
            {props.children}
          </Show>
        </tbody>
        <Show when={props.total}>
          {(total) => (
            <tfoot>
              <tr>
                <th scope="row">{props.footer}</th>
                <FigureCells figures={total()} />
              </tr>
            </tfoot>
          )}
        </Show>
      </table>
    </section>
  );
}

export function UsageLedgers(props: {
  groupBy: UsageGroupBy;
  report?: UsageReport;
  readAt?: number;
}) {
  const label = () => (props.groupBy.startsWith("label:") ? props.groupBy.slice(6) : undefined);
  const words = () => {
    const by = props.groupBy;
    return by === "batch" || by === "submitter" || by === "runner" || by === "status"
      ? grouping[by]
      : grouping.label;
  };
  const groups = () => props.report?.groups ?? [];
  const ids = createMemo(() =>
    shortIds(
      groups().flatMap((row) =>
        "runner" in row && row.runner
          ? [row.runner.id]
          : "submitter" in row
            ? [row.submitter.id]
            : [],
      ),
    ),
  );
  const today = () =>
    props.readAt === undefined ? undefined : new Date(props.readAt).toISOString().slice(0, 10);
  const largestDay = createMemo(() =>
    Math.max(0, ...(props.report?.days ?? []).map((day) => day.usage.cost.totalUsd)),
  );
  return (
    <div class="ledger-layout">
      <Ledger
        id="usage-groups"
        heading={
          <>
            {words().heading} <Show when={label()}>{(key) => <code>{key()}</code>}</Show>
          </>
        }
        column={
          <>
            {words().column} <Show when={label()}>{(key) => <code>{key()}</code>}</Show>
          </>
        }
        footer="Total"
        total={props.report}
      >
        <For each={groups()}>
          {(group) => (
            <tr>
              <th scope="row">{groupName(group, groups(), ids(), label())}</th>
              <FigureCells figures={group} largest={groups()[0]?.usage.cost.totalUsd} />
            </tr>
          )}
        </For>
        <Show
          when={
            props.report?.other && props.report.other.groups > 0 ? props.report.other : undefined
          }
        >
          {(other) => (
            <tr>
              <th scope="row">
                {formatCount(other().groups)} other{" "}
                {plural(other().groups, words().one, words().many)}
              </th>
              <FigureCells figures={other()} />
            </tr>
          )}
        </Show>
      </Ledger>
      <Ledger
        id="usage-days"
        heading="By day"
        column="Day"
        footer={`${props.report?.days.length ?? 0} days`}
        total={props.report}
      >
        <For each={props.report?.days}>
          {(day) => {
            const date = () => new Date(day.date);
            const soFar = () => day.date === props.report?.to && day.date === today();
            return (
              <tr class={{ "is-week-end": date().getUTCDay() === 0 }}>
                <th scope="row">
                  <time datetime={day.date}>
                    <span class="day-name">{UTC_WEEKDAY.format(date())}</span>{" "}
                    {UTC_DAY.format(date())}
                  </time>
                  <Show when={soFar()}>
                    {" "}
                    <span class="unit">so far</span>
                  </Show>
                </th>
                <FigureCells figures={day} largest={largestDay()} today={soFar()} />
              </tr>
            );
          }}
        </For>
      </Ledger>
    </div>
  );
}
