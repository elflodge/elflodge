import { useQuery, useQueryClient } from "@tanstack/solid-query";
import {
  Outlet,
  createFileRoute,
  useChildMatches,
  useLoaderData,
  stripSearchParams,
  useRouter,
} from "@tanstack/solid-router";
import { LABEL_KEY_PATTERN, problemOf, usageGroupBySchema } from "contract";
import { For, Show, createSignal, createEffect } from "solid-js";
import * as z from "zod/mini";

import { HubReadError, hubFailureMessage } from "../../../api-client.ts";
import { Notice } from "../../../components/Notice.tsx";
import { fieldText } from "../../../form.ts";
import { UTC_MONTH, UTC_ISO_DATE, UTC_ISO_MONTH } from "../../../format.ts";
import { readsUsage } from "../../../permissions.ts";
import { orpc } from "../../../query.ts";
import { groupings, usageGrouping } from "../../../usage-grouping.ts";

const month = z.string().check(z.regex(/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/));
export const reportDefaults = { range: "30d", groupBy: "batch" } as const;
const searchSchema = z.object({
  range: z._default(
    z.catch(z.union([z.enum(["7d", "30d"]), month]), reportDefaults.range),
    reportDefaults.range,
  ),
  groupBy: z._default(z.catch(usageGroupBySchema, reportDefaults.groupBy), reportDefaults.groupBy),
});
type UsageSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute("/_signed-in/_member/usage")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(reportDefaults)] },
  component: Usage,
});

export function rangeName(range: string) {
  if (range === "30d") return "Last 30 days";
  if (range === "7d") return "Last 7 days";
  return UTC_MONTH.format(new Date(`${range}-01`));
}

export function reportOptions({ range, groupBy }: UsageSearch) {
  const usage = orpc.usage.get;
  if (range === "30d") return usage.queryOptions({ input: { groupBy } });
  if (range === "7d") {
    // The hub takes absolute dates for seven days. A tab reopened after UTC midnight must resolve
    // them at the read, including Query's focus/reconnect reads and Show on the same report.
    return usage.queryOptions({
      input: { groupBy },
      queryKey: [...usage.queryKey({ input: { groupBy } }), range],
      queryFn: ({ signal }) => {
        const start = new Date();
        const to = UTC_ISO_DATE.format(start);
        start.setUTCDate(start.getUTCDate() - 6);
        return usage.call({ groupBy, from: UTC_ISO_DATE.format(start), to }, { signal });
      },
    });
  }
  const from = `${range}-01`;
  const end = new Date(from);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  // Intl writes years before 1000 without the leading zeroes the hub’s ISO date requires.
  const input = { groupBy, from, to: UTC_ISO_DATE.format(end).padStart(10, "0") };
  if (range < UTC_ISO_MONTH.format(new Date())) return usage.queryOptions({ input });
  return usage.queryOptions({
    input,
    // Future days have no figures yet. Resolve today at each read so an open tab follows UTC midnight.
    queryFn: ({ signal }) => {
      const now = new Date();
      return usage.call(
        { ...input, to: UTC_ISO_MONTH.format(now) === range ? UTC_ISO_DATE.format(now) : input.to },
        { signal },
      );
    },
  });
}

export function refusedReport(error: unknown): error is HubReadError {
  return error instanceof HubReadError && problemOf(error.cause)?.status === 400;
}

function Usage() {
  // The shell keeps its last completed session while a retry rebuilds route context.
  const session = useLoaderData({ from: "/_signed-in" });
  return (
    <Show
      when={readsUsage(session().membership)}
      fallback={
        <>
          <div class="head">
            <h1>Usage</h1>
          </div>
          <p class="prose">
            Usage shows what the Organization's jobs cost. Only owners and admins can read it. Each
            Batch's page shows what that Batch has used.
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
  // The form stays mounted across questions, including errors. Observe the current read's
  // timestamp and refusal here; the route loader and report own fetching.
  const report = useQuery(() => ({ ...reportOptions(search()), enabled: false }));
  const denied = () => problemOf(report.error)?.status === 403;
  createEffect(denied, (lost) => {
    if (lost) void router.invalidate({ filter: (match) => match.routeId === "/_signed-in" });
  });
  const failed = useChildMatches({
    select: (matches) =>
      matches.some((match) => match.status === "error" && !refusedReport(match.error)),
  });
  return (
    <Show
      when={!denied()}
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
        <ReportForm readAt={report.dataUpdatedAt} />
      </div>
      <Outlet />
    </Show>
  );
}

function ReportForm(props: { readAt: number }) {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const client = useQueryClient();
  const grouping = () => usageGrouping(search().groupBy);
  const [selectedRange, setRange] = createSignal(() => search().range);
  const [group, setGroup] = createSignal<string>(() => grouping().by);
  // Track each successful read so a tab left open into a new month refreshes its choices.
  // A cached report may predate the month in which the form opens.
  const [monthAt, setMonthAt] = createSignal(() => Math.max(props.readAt, Date.now()));
  const months = () => {
    const now = new Date(monthAt());
    const recent = Array.from({ length: 12 }, (_, i) =>
      UTC_ISO_MONTH.format(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)),
    );
    const range = search().range;
    return range && month.safeParse(range).success && !recent.includes(range)
      ? [...recent, range]
      : recent;
  };
  function show(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const selected = fieldText(data, "group");
    const groupBy = usageGroupBySchema.parse(
      selected === "label" ? `label:${fieldText(data, "labelKey")}` : selected,
    );
    const range = fieldText(data, "range");
    const next = { range, groupBy };
    if (range === search().range && groupBy === search().groupBy) {
      const { queryKey } = reportOptions(next);
      // An identical read already in flight can answer Show.
      if (client.getQueryData(queryKey))
        void client.invalidateQueries({ queryKey, exact: true }, { cancelRefetch: false });
      // With no answer the route is showing its first-read error. Retry its loader.
      else void router.invalidate();
    } else {
      void navigate({ search: next });
    }
  }
  return (
    <form class="filters" aria-label="Usage report" onSubmit={show}>
      <div class="filters-row">
        <div class="filter-field">
          <label for="usage-range">Range</label>
          {/* Desktop Firefox 125 and Safari 17.5 have no month picker. One select works across the dashboard floor.
          https://github.com/mdn/browser-compat-data/blob/main/html/elements/input/month.json */}
          <select
            id="usage-range"
            name="range"
            // Range may still have focus when the month changes, so update on pointer and key use too.
            onFocus={() => setMonthAt(Date.now())}
            onPointerDown={() => setMonthAt(Date.now())}
            onKeyDown={() => setMonthAt(Date.now())}
            value={selectedRange()}
            onChange={({ currentTarget }) => setRange(currentTarget.value)}
          >
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <For each={months()}>
              {(value) => <option value={value}>{rangeName(value)}</option>}
            </For>
          </select>
        </div>
        <div class="filter-field">
          <label for="usage-group">Grouped by</label>
          <select
            id="usage-group"
            name="group"
            value={group()}
            onChange={({ currentTarget }) => setGroup(currentTarget.value)}
          >
            {Object.entries(groupings).map(([value, words]) => (
              <option value={value}>{words.option}</option>
            ))}
          </select>
        </div>
        <Show when={group() === "label"}>
          <div class="filter-field">
            <label for="usage-label">Label key</label>
            <input
              class="mono"
              id="usage-label"
              name="labelKey"
              required
              value={grouping().labelKey ?? ""}
              pattern={LABEL_KEY_PATTERN.source}
              title="A Label name, optionally after a DNS prefix and /"
            />
          </div>
        </Show>
        <button type="submit" class="primary">
          Show
        </button>
      </div>
    </form>
  );
}
