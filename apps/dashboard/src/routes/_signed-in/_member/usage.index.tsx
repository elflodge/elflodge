import { useQuery } from "@tanstack/solid-query";
import { Link, createFileRoute } from "@tanstack/solid-router";
import { parseUsagePeriod, problemOf } from "contract";
import { Show } from "solid-js";

import { hubFailureDetail, readFromHub } from "../../../api-client.ts";
import { FailedReadNotice, ReadErrorPage } from "../../../components/FailedReadNotice.tsx";
import { Instant } from "../../../components/Instant.tsx";
import { UsageLedgers } from "../../../components/UsageLedgers.tsx";
import { focusAfterLinkDrops } from "../../../form.ts";
import { TIME_SECONDS_ZONED, TIME_ZONED, UTC_DAY, UTC_DAY_YEAR } from "../../../format.ts";
import { usageGrouping } from "../../../usage-grouping.ts";
import { rangeOf, rangeName, reportDefaults, reportOptions, refusedReport } from "./usage.tsx";

export const Route = createFileRoute("/_signed-in/_member/usage/")({
  // Read on activation, on Show and when a stale report becomes visible. A 30-day report by
  // Batch over 100,000 job ends took 93 ms, against 0.25 ms for the first Jobs page and
  // 21 ms for Batches (medians of five warm reads). Hovering a link should not incur that read.
  preload: false,
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    if (!context.readsUsage) return;
    await readFromHub("Usage", () =>
      context.queryClient.query({ ...reportOptions(deps), staleTime: "static" }),
    );
  },
  pendingComponent: () => {
    const search = Route.useSearch();
    const grouping = () => usageGrouping(search().groupBy);
    return (
      <>
        <Show when={grouping()}>{(group) => <UsageLedgers grouping={group()} />}</Show>
        <p class="vh" role="status">
          Loading Usage
        </p>
      </>
    );
  },
  errorComponent: (props) => {
    const search = Route.useSearch();
    const error = props.error;
    const focusRange = focusAfterLinkDrops(() => document.getElementById("usage-range"));
    if (refusedReport(error)) return null;
    return (
      <ReadErrorPage {...props} heading="Usage">
        <Show
          when={
            rangeOf(search()) !== reportDefaults.period ||
            search().groupBy !== reportDefaults.groupBy
          }
        >
          <p>
            <Link
              class="stands-alone"
              to="/usage"
              search={{ groupBy: reportDefaults.groupBy }}
              onClick={focusRange}
            >
              Show the last 30 days by Batch
            </Link>
          </p>
        </Show>
      </ReadErrorPage>
    );
  },
  component: Report,
});

function Report() {
  const search = Route.useSearch();
  const grouping = () => usageGrouping(search().groupBy);
  const query = useQuery(() => reportOptions(search()));
  const period = () => {
    const from = new Date(query.data.from);
    const to = new Date(query.data.to);
    const year = query.data.today.slice(0, 4);
    const format =
      query.data.from.startsWith(year) && query.data.to.startsWith(year) ? UTC_DAY : UTC_DAY_YEAR;
    return format.formatRange(from, to);
  };
  const range = () => rangeOf(search());
  const soFar = () => query.data.to === query.data.today;
  const focusRange = focusAfterLinkDrops(() => document.getElementById("usage-range"));
  const empty = () => {
    if (range() === "custom") return "No job ended in this range";
    if (parseUsagePeriod(range())?.kind === "days")
      return `No job has ended in the ${rangeName(range()).toLowerCase()}`;
    return soFar()
      ? `No job has ended in ${rangeName(range())} yet`
      : `No job ended in ${rangeName(range())}`;
  };
  return (
    <>
      <p class="report-range">
        <Show when={range() !== "custom"}>
          {rangeName(range())}
          {soFar() ? " so far" : ""},{" "}
        </Show>
        {period()} (UTC){range() === "custom" && soFar() ? " so far" : ""}.
      </p>
      <p class="note">
        Each job end counts on the day the hub recorded it, deleted jobs included. A job resumed
        after it ended counts again. Read at{" "}
        <Instant value={query.data.readAt} format={TIME_ZONED} />.
      </p>
      <Show when={query.isError && problemOf(query.error)?.status !== 400}>
        <FailedReadNotice
          what="Usage"
          detail={hubFailureDetail(query.error)}
          failedAt={query.errorUpdatedAt}
          readAt={query.data.readAt.getTime()}
          format={TIME_SECONDS_ZONED}
        />
      </Show>
      <Show
        when={query.data.jobEnds > 0}
        fallback={
          <div class="empty">
            <h2>{empty()}</h2>
            <Show when={range() !== "30d"}>
              <p class="empty-act">
                <Link
                  class="stands-alone"
                  to="/usage"
                  search={{ groupBy: search().groupBy }}
                  onClick={focusRange}
                >
                  Show the last 30 days
                </Link>
              </p>
            </Show>
          </div>
        }
      >
        <Show when={grouping()}>
          {(group) => <UsageLedgers report={query.data} grouping={group()} />}
        </Show>
      </Show>
    </>
  );
}
