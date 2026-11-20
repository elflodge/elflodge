import type { JSX } from "@solidjs/web";
import { Link } from "@tanstack/solid-router";
import type { UsageGroup, UsageReport } from "contract";
import { For, Repeat, Show, createMemo } from "solid-js";

import { formatCount, formatUsd, plural, UTC_DAY, UTC_WEEKDAY, UTC_ISO_DATE } from "../format.ts";
import { shortIds } from "../short-ids.ts";
import { groupings, type usageGrouping } from "../usage-grouping.ts";
import { JobSubmitter } from "./JobReferences.tsx";
import { STATUS_WORDS } from "./JobStatus.tsx";

type Figures = Pick<UsageReport, "jobEnds" | "usage">;

function groupName(
  group: UsageGroup,
  groups: UsageGroup[],
  ids: Map<string, string>,
  label?: string,
) {
  // A Batch cannot be deleted, so its recorded ID still opens its page.
  if ("batchId" in group)
    return (
      <Link class="mono stands-alone" to="/batches/$id" params={{ id: group.batchId }}>
        {group.batchId}
      </Link>
    );
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
      <code class="label-value">{JSON.stringify(group.labelValue)}</code>
    );
  // A removed Runner has no record to link to: the hub gives its ID without a name.
  if ("runner" in group)
    return group.runner === null ? (
      "No Runner: ended before one started them"
    ) : (
      <>
        {group.runner.name === undefined ? (
          "A Runner since removed"
        ) : (
          <Link class="mono stands-alone" to="/runners" hash={group.runner.id}>
            {group.runner.name}
          </Link>
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
      <table
        class="ledger by-cost"
        aria-labelledby={props.id}
        aria-busy={props.total ? undefined : "true"}
      >
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
              <Repeat count={8}>
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
  grouping: ReturnType<typeof usageGrouping>;
  report?: UsageReport;
  readAt?: number;
}) {
  const dayCount = () => props.report?.days.length ?? 0;
  const label = () => props.grouping.labelKey;
  const words = () => groupings[props.grouping.by];
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
  const today = () => (props.readAt === undefined ? undefined : UTC_ISO_DATE.format(props.readAt));
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
        footer={`${formatCount(dayCount())} ${plural(dayCount(), "day", "days")}`}
        total={props.report}
      >
        <For each={props.report?.days}>
          {(day) => {
            const date = () => new Date(day.date);
            const soFar = () => day.date === props.report?.to && day.date === today();
            return (
              <tr class={{ "is-last-day-of-week": date().getUTCDay() === 0 }}>
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
