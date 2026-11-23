import type { JSX } from "@solidjs/web";
import { Link } from "@tanstack/solid-router";
import type { UsageGroupBy, UsageReport } from "contract";
import { For, Repeat, Show, createMemo } from "solid-js";

import { formatCount, formatUsd, plural, UTC_DAY, UTC_WEEKDAY } from "../format.ts";
import { shortIds } from "../short-ids.ts";
import { groupings, usageGrouping } from "../usage-grouping.ts";
import { JobSubmitter, RunnerReference, submitterName } from "./JobReferences.tsx";
import { JobStatus } from "./JobStatus.tsx";

type Figures = Pick<UsageReport, "jobEnds" | "usage">;

function renderRows<Row extends Figures>(groups: Row[], name: (row: Row) => JSX.Element) {
  const largest = groups[0]?.usage.cost.totalUsd;
  return (
    <For each={groups}>
      {(row) => (
        <tr>
          <th scope="row" class="is-name">
            {name(row)}
          </th>
          <FigureCells figures={row} largest={largest} />
        </tr>
      )}
    </For>
  );
}

function groupRows(report: UsageReport) {
  switch (report.groupBy) {
    case undefined:
      return null;
    case "batch":
      // A Batch cannot be deleted, so its recorded ID still opens its page.
      return renderRows(report.groups, ({ batchId }) => (
        <Link
          class="mono cut stands-alone"
          title={batchId}
          to="/batches/$id"
          params={{ id: batchId }}
        >
          {batchId}
        </Link>
      ));
    case "status":
      return renderRows(report.groups, ({ status }) => (
        <JobStatus status={status} lastRecorded={false} />
      ));
    case "runner": {
      const ids = shortIds(report.groups.flatMap(({ runner }) => (runner ? [runner.id] : [])));
      return renderRows(report.groups, ({ runner }) =>
        runner === null ? (
          "No Runner: ended before one started them"
        ) : (
          <RunnerReference linked runner={runner} shortId={ids.get(runner.id) ?? runner.id} />
        ),
      );
    }
    case "submitter": {
      const ids = shortIds(report.groups.map(({ submitter }) => submitter.id));
      return renderRows(report.groups, ({ submitter }) => (
        <>
          <JobSubmitter submitter={submitter} />{" "}
          <Show
            when={report.groups.some(
              ({ submitter: other }) =>
                other.id !== submitter.id && submitterName(other) === submitterName(submitter),
            )}
          >
            <span class="sid" title={submitter.id}>
              {ids.get(submitter.id)}
            </span>
          </Show>
        </>
      ));
    }
    default: {
      const label = usageGrouping(report.groupBy).labelKey;
      return renderRows(report.groups, ({ labelValue }) =>
        labelValue === null ? (
          <>
            Jobs without the Label <code>{label}</code>
          </>
        ) : (
          <code class="label-value">{JSON.stringify(labelValue)}</code>
        ),
      );
    }
  }
}

function FigureCells(props: { figures: Figures; largest?: number }) {
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
              Against the largest
            </th>
          </tr>
        </thead>
        <Show
          when={props.total}
          fallback={
            <tbody>
              <Repeat count={8}>
                {() => (
                  <tr aria-hidden="true">
                    <td colspan={5}>
                      <span class="sk" />
                    </td>
                  </tr>
                )}
              </Repeat>
            </tbody>
          }
        >
          {props.children}
        </Show>
        <Show when={props.total} keyed>
          {(total) => (
            <tfoot>
              <tr>
                <th scope="row">{props.footer}</th>
                <FigureCells figures={total} />
              </tr>
            </tfoot>
          )}
        </Show>
      </table>
    </section>
  );
}

export function UsageLedgers(props: {
  pendingGroupBy?: UsageGroupBy;
  report?: UsageReport;
  showYears?: boolean;
}) {
  const years = createMemo(() =>
    Array.from(Map.groupBy(props.report?.days ?? [], (day) => day.date.slice(0, 4))),
  );
  const dayCount = () => props.report?.days.length ?? 0;
  const groupBy = () => (props.report ? props.report.groupBy : props.pendingGroupBy);
  // Only the visual scale compares days here. Every printed figure comes from the report.
  const largestDay = createMemo(() =>
    Math.max(0, ...(props.report?.days ?? []).map((day) => day.usage.cost.totalUsd)),
  );
  return (
    <div class="ledger-layout">
      <Show when={groupBy()} keyed>
        {(by) => {
          const { by: kind, labelKey } = usageGrouping(by);
          const words = groupings[kind];
          return (
            <Ledger
              id="usage-groups"
              heading={
                <>
                  {words.heading}{" "}
                  <Show when={labelKey} keyed>
                    {(key) => <code>{key}</code>}
                  </Show>
                </>
              }
              column={
                <>
                  {words.column}{" "}
                  <Show when={labelKey} keyed>
                    {(key) => <code>{key}</code>}
                  </Show>
                </>
              }
              footer="Total"
              total={props.report}
            >
              <tbody>
                <Show when={props.report} keyed>
                  {groupRows}
                </Show>
                <Show
                  when={
                    props.report?.other && props.report.other.groups > 0
                      ? props.report.other
                      : undefined
                  }
                  keyed
                >
                  {(other) => (
                    <tr>
                      <th scope="row">
                        {formatCount(other.groups)} other{" "}
                        {plural(other.groups, words.one, words.many)}
                      </th>
                      <FigureCells figures={other} />
                    </tr>
                  )}
                </Show>
              </tbody>
            </Ledger>
          );
        }}
      </Show>
      <Ledger
        id="usage-days"
        heading="By day"
        column="Day"
        footer={`${formatCount(dayCount())} ${plural(dayCount(), "day", "days")}`}
        total={props.report}
      >
        <For each={years()} keyed={([year]) => year}>
          {(group) => (
            <tbody>
              <Show when={props.showYears}>
                <tr class="day-line">
                  <th scope="rowgroup" colspan={5}>
                    {group()[0]}
                  </th>
                </tr>
              </Show>
              <For each={group()[1]} keyed={(day) => day.date}>
                {(day) => {
                  const date = () => new Date(day().date);
                  const soFar = () => day().date === props.report?.today;
                  return (
                    <tr class={{ "is-last-day-of-week": date().getUTCDay() === 0 }}>
                      <th scope="row">
                        <time datetime={day().date}>
                          <span class="day-name">{UTC_WEEKDAY.format(date())}</span>{" "}
                          <span>{UTC_DAY.format(date())}</span>
                        </time>
                        <Show when={soFar()}>
                          {" "}
                          <span class="unit">so far</span>
                        </Show>
                      </th>
                      <FigureCells figures={day()} largest={largestDay()} />
                    </tr>
                  );
                }}
              </For>
            </tbody>
          )}
        </For>
      </Ledger>
    </div>
  );
}
