import { useQuery } from "@tanstack/solid-query";
import { Link, createFileRoute } from "@tanstack/solid-router";
import { Show } from "solid-js";

import { hubFailureMessage, readFromHub } from "../../../api-client.ts";
import { FailedReadNotice, ReadErrorPage } from "../../../components/FailedReadNotice.tsx";
import { Instant } from "../../../components/Instant.tsx";
import { Notice } from "../../../components/Notice.tsx";
import { UsageLedgers } from "../../../components/UsageLedgers.tsx";
import { TIME_ZONED, UTC_DAY, UTC_DAY_YEAR } from "../../../format.ts";
import { canReadUsage } from "../../../permissions.ts";
import { rangeName, reportOptions, refusedReport } from "./usage.tsx";

export const Route = createFileRoute("/_signed-in/_member/usage/")({
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    if (!context.member || !canReadUsage(context.member.role)) return;
    await readFromHub("Usage", () =>
      context.queryClient.query({ ...reportOptions(deps), staleTime: "static" }),
    );
  },
  pendingComponent: () => {
    const search = Route.useSearch();
    return (
      <>
        <UsageLedgers groupBy={search().groupBy ?? "batch"} />
        <p class="vh" role="status">
          Loading Usage
        </p>
      </>
    );
  },
  errorComponent: (props) => {
    const error = props.error;
    if (refusedReport(error)) return <Notice role="alert">{error.detail}</Notice>;
    return <ReadErrorPage {...props} heading="Usage" />;
  },
  component: Report,
});

function Report() {
  const search = Route.useSearch();
  const query = useQuery(() => reportOptions(search()));
  const period = () => {
    const from = new Date(query.data.from);
    const to = new Date(query.data.to);
    const year = new Date(query.dataUpdatedAt).getUTCFullYear();
    const format =
      from.getUTCFullYear() === year && to.getUTCFullYear() === year ? UTC_DAY : UTC_DAY_YEAR;
    return format.formatRange(from, to);
  };
  const empty = () => {
    const range = search().range ?? "30d";
    return range.endsWith("d")
      ? `No job has ended in the ${rangeName(range).toLowerCase()}.`
      : `No job ended in ${rangeName(range)}.`;
  };
  return (
    <>
      <p class="note">
        <span>
          {rangeName(search().range)}, {period()}, UTC days. Each job end counts on the day the hub
          recorded it, deleted jobs included. A job resumed after it ended counts again. Read at{" "}
          <Instant value={new Date(query.dataUpdatedAt)} format={TIME_ZONED} />.
        </span>
      </p>
      <Show when={query.isError}>
        <FailedReadNotice
          what="Usage"
          detail={hubFailureMessage(query.error)}
          failedAt={query.errorUpdatedAt}
          readAt={query.dataUpdatedAt}
          format={TIME_ZONED}
        />
      </Show>
      <Show
        when={query.data.jobEnds > 0}
        fallback={
          <div class="empty">
            <h2>{empty()}</h2>
            <Show when={(search().range ?? "30d") !== "30d"}>
              <p>
                <Link class="stands-alone" to="/usage" search={{ groupBy: search().groupBy }}>
                  Show the last 30 days
                </Link>
              </p>
            </Show>
          </div>
        }
      >
        <UsageLedgers
          report={query.data}
          groupBy={search().groupBy ?? "batch"}
          readAt={query.dataUpdatedAt}
        />
      </Show>
    </>
  );
}
