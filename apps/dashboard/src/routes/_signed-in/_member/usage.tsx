import { useQuery } from "@tanstack/solid-query";
import {
  Link,
  Outlet,
  createFileRoute,
  useChildMatches,
  useLoaderData,
  stripSearchParams,
  useRouter,
} from "@tanstack/solid-router";
import {
  LABEL_KEY_PATTERN,
  problemOf,
  usageGroupBySchema,
  usagePeriodSchema,
  type UsageReport,
} from "contract";
import { For, Show, createSignal, createEffect } from "solid-js";
import * as z from "zod/mini";

import { HubReadError, hubFailureMessage } from "../../../api-client.ts";
import { Notice } from "../../../components/Notice.tsx";
import { fieldText } from "../../../form.ts";
import { UTC_MONTH } from "../../../format.ts";
import { canReadUsage } from "../../../permissions.ts";
import { orpc } from "../../../query.ts";
import { createSearchForm, optionalText } from "../../../search-form.ts";
import { groupings, usageGrouping } from "../../../usage-grouping.ts";

export const reportDefaults = { period: "30d", groupBy: "batch" } as const;
const searchSchema = z.object({
  period: optionalText,
  from: optionalText,
  to: optionalText,
  // A Label key in a shared address may never have passed the form’s native validation.
  groupBy: z._default(
    z.catch(z.union([usageGroupBySchema, z.templateLiteral(["label:", z.string()])]), "batch"),
    "batch",
  ),
});
type UsageSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute("/_signed-in/_member/usage")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(reportDefaults)] },
  component: Usage,
});

export function rangeOf(search: UsageSearch) {
  return search.period ?? (search.from || search.to ? "custom" : "30d");
}
export function rangeName(range: string) {
  if (range === "custom") return "Custom range";
  if (!usagePeriodSchema.safeParse(range).success) return range;
  if (range.endsWith("d")) {
    const days = Number(range.slice(0, -1));
    return `Last ${days} ${days === 1 ? "day" : "days"}`;
  }
  return UTC_MONTH.format(new Date(`${range}-01`));
}

export function reportOptions(search: UsageSearch) {
  // An absent preset and the explicit default ask the same question.
  const input = {
    ...search,
    period: search.period ?? (search.from || search.to ? undefined : "30d"),
  };
  return orpc.usage.get.queryOptions({ input });
}

export function refusedReport(error: unknown): error is HubReadError {
  return error instanceof HubReadError && problemOf(error.cause)?.status === 400;
}

function Usage() {
  // The shell keeps its last completed session while a retry rebuilds route context.
  const session = useLoaderData({ from: "/_signed-in" });
  return (
    <Show
      when={canReadUsage(session().membership)}
      fallback={
        <>
          <div class="head">
            <h1>Usage</h1>
          </div>
          <p class="prose">
            Usage shows what the Organization's jobs cost. Only owners and admins can read it. Each
            Batch's page shows what that Batch has used.
          </p>
          <p>
            <Link class="stands-alone" to="/batches">
              Batches
            </Link>
          </p>
        </>
      }
    >
      <GrantedUsage />
    </Show>
  );
}

function GrantedUsage() {
  const search = Route.useSearch();
  const router = useRouter();
  // The form observes the shown report and its refusal. The loader and the report own fetching.
  const report = useQuery(() => ({ ...reportOptions(search()), enabled: false }));
  const problem = () => problemOf(report.error);
  createEffect(
    () => problem()?.status === 403,
    (lost) => {
      if (lost) void router.invalidate({ filter: (match) => match.routeId === "/_signed-in" });
    },
  );
  const failed = useChildMatches({
    select: (matches) =>
      matches.some((match) => match.status === "error" && !refusedReport(match.error)),
  });
  return (
    <Show
      when={problem()?.status !== 403}
      fallback={
        <>
          <div class="head">
            <h1>Usage</h1>
          </div>
          <Notice role="alert">{hubFailureMessage(report.error)}</Notice>
        </>
      }
    >
      <div hidden={failed()}>
        <div class="head">
          <h1>Usage</h1>
        </div>
        <ReportForm report={report.dataUpdatedAt ? report.data : undefined} />
        {/* Problem Details gives the reason in words and has no structured field location. */}
        <Show when={problem()?.status === 400}>
          <Notice role="alert">{hubFailureMessage(report.error)}</Notice>
        </Show>
      </div>
      <Outlet />
    </Show>
  );
}

function ReportForm(props: { report?: UsageReport }) {
  const search = Route.useSearch();
  const range = () => rangeOf(search());
  const grouping = () => usageGrouping(search().groupBy);
  const [draftRange, setRange] = createSignal<string>();
  const [draftGroup, setGroup] = createSignal<string>();
  const months = () => {
    const anchor = new Date(props.report?.today ?? Date.now());
    anchor.setUTCDate(1);
    const recent = Array.from({ length: 12 }, () => {
      const month = anchor.toISOString().slice(0, 7);
      anchor.setUTCMonth(anchor.getUTCMonth() - 1);
      return month;
    });
    const selected = range();
    if (!["7d", "30d", "custom", ...recent].includes(selected)) recent.push(selected);
    return recent;
  };
  const { pending, onSubmit } = createSearchForm({
    to: "/usage",
    schema: searchSchema,
    beforeSubmit(form) {
      if (form.get("period") === "custom") form.delete("period");
      if (form.get("groupBy") === "label")
        form.set("groupBy", `label:${fieldText(form, "labelKey")}`);
    },
    queryKey: (input) => reportOptions(input).queryKey,
    retryFirstRead: true,
  });
  let form: HTMLFormElement | undefined;
  createEffect(search, () => form?.reset(), { defer: true });
  return (
    <form
      ref={(el) => {
        form = el;
      }}
      class="filters"
      aria-label="Usage report"
      onSubmit={onSubmit}
      onReset={() => {
        setRange(undefined);
        setGroup(undefined);
      }}
    >
      <div class="filters-row">
        <div class="filter-field">
          <label for="usage-range">Range</label>
          {/* Desktop Firefox 125 and Safari 17.5 have no month picker. */}
          <select
            id="usage-range"
            name="period"
            onChange={({ currentTarget }) => setRange(currentTarget.value)}
          >
            <For each={["7d", "30d", ...months(), "custom"]}>
              {(value) => (
                <option value={value} defaultSelected={value === range()}>
                  {rangeName(value)}
                </option>
              )}
            </For>
          </select>
        </div>
        <Show when={(draftRange() ?? range()) === "custom"}>
          <For each={["from", "to"] as const}>
            {(name) => (
              <div class="filter-field">
                <label for={`usage-${name}`}>{name === "from" ? "From" : "To"}</label>
                <input
                  type="date"
                  name={name}
                  id={`usage-${name}`}
                  required={name === "from"}
                  defaultValue={
                    (draftRange() === "custom"
                      ? (props.report?.[name] ?? search()[name])
                      : search()[name]) ?? ""
                  }
                />
              </div>
            )}
          </For>
        </Show>
        <div class="filter-field">
          <label for="usage-group">Grouped by</label>
          <select
            id="usage-group"
            name="groupBy"
            onChange={({ currentTarget }) => setGroup(currentTarget.value)}
          >
            {Object.entries(groupings).map(([value, words]) => (
              <option value={value} defaultSelected={grouping().by === value}>
                {words.option}
              </option>
            ))}
          </select>
        </div>
        <Show when={(draftGroup() ?? grouping().by) === "label"}>
          <div class="filter-field">
            <label for="usage-label">Label key</label>
            <input
              id="usage-label"
              name="labelKey"
              pattern={LABEL_KEY_PATTERN.source}
              title="A Label name, optionally after a DNS prefix and /"
              required
              defaultValue={grouping().labelKey ?? ""}
            />
          </div>
        </Show>
        <span class="filter-act">
          <button type="submit" class="primary" aria-disabled={pending() ? "true" : undefined}>
            Show
          </button>
        </span>
      </div>
    </form>
  );
}
