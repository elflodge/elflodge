import { useQueryClient } from "@tanstack/solid-query";
import {
  Outlet,
  createFileRoute,
  useChildMatches,
  useLoaderData,
  useRouter,
} from "@tanstack/solid-router";
import { problemOf, usageGroupBySchema } from "contract";
import { For, Show, createSignal } from "solid-js";
import * as z from "zod/mini";

import { HubReadError } from "../../../api-client.ts";
import { fieldText } from "../../../form.ts";
import { UTC_MONTH } from "../../../format.ts";
import { canReadUsage } from "../../../permissions.ts";
import { orpc } from "../../../query.ts";

const month = z.string().check(z.regex(/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/));
const searchSchema = z.object({
  range: z.catch(z.optional(z.union([z.enum(["7d", "30d"]), month])), undefined),
  groupBy: z.catch(z.optional(usageGroupBySchema), undefined),
});
type UsageSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute("/_signed-in/_member/usage")({
  validateSearch: searchSchema,
  component: Usage,
});

const GROUPS = {
  batch: "Batch",
  submitter: "Submitter",
  runner: "Runner",
  status: "Status",
  label: "Label",
} as const;
export function rangeName(range = "30d") {
  if (range === "30d") return "Last 30 days";
  if (range === "7d") return "Last 7 days";
  return UTC_MONTH.format(new Date(`${range}-01`));
}

export function reportOptions({ range = "30d", groupBy = "batch" }: UsageSearch) {
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
        const to = start.toISOString().slice(0, 10);
        start.setUTCDate(start.getUTCDate() - 6);
        return usage.call({ groupBy, from: start.toISOString().slice(0, 10), to }, { signal });
      },
    });
  }
  const from = `${range}-01`;
  const end = new Date(from);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  return usage.queryOptions({ input: { groupBy, from, to: end.toISOString().slice(0, 10) } });
}

export function refusedReport(error: unknown): error is HubReadError {
  return error instanceof HubReadError && problemOf(error.cause)?.status === 400;
}

function Usage() {
  // The shell keeps its last completed session while a retry rebuilds route context.
  const session = useLoaderData({ from: "/_signed-in" });
  const readsUsage = () => {
    const { membership } = session();
    return membership.status === "member" && canReadUsage(membership.role);
  };
  const failed = useChildMatches({
    select: (matches) =>
      matches.some((match) => match.status === "error" && !refusedReport(match.error)),
  });
  return (
    <>
      <div hidden={failed()}>
        <div class="head">
          <h1>Usage</h1>
        </div>
        <Show
          when={readsUsage()}
          fallback={
            <p class="prose">
              Usage shows what every Member's work cost. Only owners and admins see it. Ask one for
              the figures you need.
            </p>
          }
        >
          <ReportForm />
        </Show>
      </div>
      <Show when={readsUsage()}>
        <Outlet />
      </Show>
    </>
  );
}

function ReportForm() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const client = useQueryClient();
  const [selectedRange, setRange] = createSignal(() => search().range ?? "30d");
  const [group, setGroup] = createSignal(() => search().groupBy?.split(":", 1)[0] ?? "batch");
  const months = () => {
    const now = new Date();
    const recent = Array.from({ length: 12 }, (_, i) =>
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7),
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
    const next = {
      range: range === "30d" ? undefined : range,
      groupBy: groupBy === "batch" ? undefined : groupBy,
    };
    if (range === (search().range ?? "30d") && groupBy === (search().groupBy ?? "batch")) {
      const { queryKey } = reportOptions(next);
      if (client.getQueryData(queryKey))
        void client.invalidateQueries({ queryKey, exact: true }, { cancelRefetch: false });
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
            {Object.entries(GROUPS).map(([value, name]) => (
              <option value={value}>{name}</option>
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
              value={search().groupBy?.startsWith("label:") ? search().groupBy?.slice(6) : ""}
              // HTML patterns use Unicode sets, so the contract’s literal hyphens are escaped.
              pattern={String.raw`(?:(?=.{1,253}\/)[a-z0-9](?:[\-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[\-a-z0-9]*[a-z0-9])?)*\/)?[A-Za-z0-9](?:[\-_.A-Za-z0-9]{0,61}[A-Za-z0-9])?`}
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
