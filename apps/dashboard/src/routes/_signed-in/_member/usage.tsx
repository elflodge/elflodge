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
import { Button } from "@ui-sdk/solid/button";
import { FieldControl } from "@ui-sdk/solid/field";
import { Input } from "@ui-sdk/solid/input";
import {
  LABEL_KEY_PATTERN,
  problemOf,
  usageGroupBySchema,
  MAX_USAGE_DAYS,
  parseUsagePeriod,
  type UsageReport,
} from "contract";
import { For, Show, createMemo, createSignal, createEffect } from "solid-js";
import * as z from "zod/mini";

import { HubReadError, hubFailureMessage } from "../../../api-client.ts";
import { Field } from "../../../components/Field.tsx";
import { Notice } from "../../../components/Notice.tsx";
import { fieldText, formRefusal } from "../../../form.ts";
import { UTC_MONTH } from "../../../format.ts";
import { memberPageHead } from "../../../page-title.ts";
import { canReadUsage } from "../../../permissions.ts";
import { orpc } from "../../../query.ts";
import { createSearchForm, optionalText } from "../../../search-form.ts";
import { groupings, usageGrouping } from "../../../usage-grouping.ts";

export const reportDefaults = { period: "30d", groupBy: "batch" } as const;
const searchSchema = z.object({
  period: optionalText,
  from: optionalText,
  to: optionalText,
  // As on Jobs and Batches, drop unusable filters. Keep a Label key so the hub can explain its refusal.
  groupBy: z._default(
    z.catch(
      z.union([usageGroupBySchema, z.templateLiteral(["label:", z.string()])]),
      reportDefaults.groupBy,
    ),
    reportDefaults.groupBy,
  ),
});
type UsageSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute("/_signed-in/_member/usage")({
  head: ({ match }) => memberPageHead(match.context, "Usage"),
  validateSearch: searchSchema,
  search: {
    middlewares: [
      ({ search, next, meta }) => {
        const destination = next(search);
        // A period beside either date is a conflicting request, including an explicit 30d.
        const defaults =
          destination.from || destination.to ? { groupBy: reportDefaults.groupBy } : reportDefaults;
        return stripSearchParams<typeof destination>(defaults)({
          search: destination,
          next: (value) => value,
          meta,
        });
      },
    ],
  },
  component: Usage,
});

export function rangeOf(search: UsageSearch) {
  return search.period ?? (search.from || search.to ? "custom" : "30d");
}
export function rangeName(range: string) {
  if (range === "custom") return "Custom range";
  const parsed = parseUsagePeriod(range);
  if (!parsed) return range;
  if (parsed.kind === "days") {
    const { days } = parsed;
    return `Last ${days} ${days === 1 ? "day" : "days"}`;
  }
  return UTC_MONTH.format(new Date(`${parsed.month}-01`));
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
          <p class="prose">
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
        <ReportForm
          report={report.dataUpdatedAt ? report.data : undefined}
          error={problem()?.status === 400 ? report.error : undefined}
        />
      </div>
      <Outlet />
    </Show>
  );
}

function ReportForm(props: { report?: UsageReport; error?: unknown }) {
  const search = Route.useSearch();
  const range = () => rangeOf(search());
  const grouping = () => usageGrouping(search().groupBy);
  const [draftRange, setRange] = createSignal<string>();
  const [draftGroup, setGroup] = createSignal<string>();
  const custom = () => (draftRange() ?? range()) === "custom";
  const label = () => (draftGroup() ?? grouping().by) === "label";
  // Place the refusal by the applied search that the hub answered. Editing the draft can
  // hide its control, in which case the message stays in the alert until the next read.
  // Range supplies the period and both dates until Custom exposes the dates separately.
  // Grouped by supplies groupBy until Label exposes the key that completes its value.
  const refusal = createMemo(() =>
    props.error
      ? formRefusal(props.error, {
          range: range() === "custom" ? ["period"] : ["period", "from", "to"],
          from: range() === "custom" && custom() ? ["from"] : [],
          to: range() === "custom" && custom() ? ["to"] : [],
          group: grouping().by === "label" ? [] : ["groupBy"],
          label: grouping().by === "label" && label() ? ["groupBy"] : [],
        })
      : undefined,
  );
  const field = (name: string) => refusal()?.fields.get(name);
  const months = () => {
    // Effect DateTime.subtract with Array.makeBy added 6,398 gzipped client bytes for this list.
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
  const { pending, onSubmit, resetForNavigation } = createSearchForm({
    to: "/usage",
    schema: searchSchema,
    beforeSubmit(form) {
      if (form.get("period") === "custom" || form.get("period") === reportDefaults.period)
        form.delete("period");
      // The hub supplied From for an end-only address. The unchanged dates still ask that question.
      if (
        search().from === undefined &&
        search().to === form.get("to") &&
        props.report?.from === form.get("from")
      )
        form.delete("from");
      if (form.get("groupBy") === "label")
        form.set("groupBy", `label:${fieldText(form, "labelKey")}`);
    },
    queryKey: (input) => reportOptions(input).queryKey,
  });
  let form: HTMLFormElement | undefined;
  createEffect(
    search,
    () => {
      if (form) {
        resetForNavigation(form);
        // Reset restores field values, but the browser keeps a custom validation message.
        checkWindow(form);
      }
    },
    { defer: true },
  );
  function dateValue(name: "from" | "to") {
    if (draftRange() === "custom") return props.report?.[name] ?? search()[name] ?? "";
    return search()[name] ?? (name === "from" ? props.report?.from : undefined) ?? "";
  }
  // When the fields mount or get new defaults, From may already hold the member's edit.
  createEffect(
    () => ((draftRange() ?? range()) === "custom" ? dateValue("from") : undefined),
    () => {
      if (form) checkWindow(form);
    },
  );
  function checkWindow(element: HTMLFormElement) {
    const from = element.elements.namedItem("from");
    const to = element.elements.namedItem("to");
    if (!(from instanceof HTMLInputElement) || !(to instanceof HTMLInputElement)) return;
    to.min = from.value;
    // Without a shown report we cannot tell whether the hub will cap To at its UTC today.
    const today = props.report?.today;
    const end = today ? Math.min(Date.parse(today), to.value ? to.valueAsNumber : Infinity) : NaN;
    const days = (end - from.valueAsNumber) / 86_400_000 + 1;
    from.setCustomValidity(
      days > MAX_USAGE_DAYS
        ? `Choose at most ${MAX_USAGE_DAYS} days, counting both From and To.`
        : "",
    );
  }
  return (
    <form
      ref={(el) => {
        form = el;
      }}
      class="filters"
      aria-label="Usage report"
      onInput={({ currentTarget }) => checkWindow(currentTarget)}
      onSubmit={async (event) => {
        checkWindow(event.currentTarget);
        if (event.currentTarget.reportValidity()) await onSubmit(event);
        else event.preventDefault();
      }}
      onReset={() => {
        setRange(undefined);
        setGroup(undefined);
      }}
    >
      <div class="filters-row">
        {/* Desktop Firefox 125 and Safari 17.5 have no month picker. */}
        <Field class="filter-field" label="Range" error={field("range")}>
          <FieldControl
            render={(part) => <select {...part} />}
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
          </FieldControl>
        </Field>
        <Show when={custom()}>
          <For each={["from", "to"] as const}>
            {(name) => (
              <Field
                class="filter-field"
                label={name === "from" ? "From" : "To"}
                error={field(name)}
              >
                <FieldControl
                  render={(part) => <input {...part} />}
                  type="date"
                  name={name}
                  required={name === "from"}
                  defaultValue={dateValue(name)}
                />
              </Field>
            )}
          </For>
        </Show>
        <Field class="filter-field" label="Grouped by" error={field("group")}>
          <FieldControl
            render={(part) => <select {...part} />}
            name="groupBy"
            onChange={({ currentTarget }) => setGroup(currentTarget.value)}
          >
            {Object.entries(groupings).map(([value, words]) => (
              <option value={value} defaultSelected={grouping().by === value}>
                {words.option}
              </option>
            ))}
          </FieldControl>
        </Field>
        <Show when={label()}>
          <Field class="filter-field" label="Label key" error={field("label")}>
            <Input
              name="labelKey"
              pattern={LABEL_KEY_PATTERN.source}
              title="A Label name, optionally after a DNS prefix and /"
              required
              defaultValue={grouping().labelKey ?? ""}
            />
          </Field>
        </Show>
        <span class="filter-act">
          <Button type="submit" class="primary" disabled={pending()} focusableWhenDisabled>
            Show
          </Button>
        </span>
      </div>
      <Show when={refusal()?.alert} keyed>
        {(message) => <Notice role="alert">{message}</Notice>}
      </Show>
    </form>
  );
}
