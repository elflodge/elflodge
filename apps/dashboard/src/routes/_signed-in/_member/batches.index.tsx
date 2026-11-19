import { useQuery } from "@tanstack/solid-query";
import { Link, createFileRoute } from "@tanstack/solid-router";
import type { ListedBatch } from "contract";
import { For, Repeat, Show } from "solid-js";

import { hubFailureMessage, readFromHub } from "../../../api-client.ts";
import { totalJobs, unfinishedJobs } from "../../../batch.ts";
import { BatchStatus, BatchConditions } from "../../../components/BatchStatus.tsx";
import { FailedReadNotice, ReadErrorPage } from "../../../components/FailedReadNotice.tsx";
import { Instant } from "../../../components/Instant.tsx";
import { JobSubmitter } from "../../../components/JobReferences.tsx";
import { EmptyList, ListEnd, availableRunners } from "../../../components/ListEnd.tsx";
import { formatCount, timeZoneNote } from "../../../format.ts";
import { REFRESH_INTERVAL_MS, orpc } from "../../../query.ts";
import { filterCount, listInput } from "./batches.tsx";

export const Route = createFileRoute("/_signed-in/_member/batches/")({
  loaderDeps: ({ search }) => listInput(search),
  loader: async ({ context, deps }) => {
    if (!context.member) return;
    await readFromHub("The Batches", () =>
      context.queryClient.query(
        orpc.batches.list.queryOptions({ input: deps, staleTime: "static" }),
      ),
    );
  },
  pendingComponent: () => (
    <>
      <BatchTable />
      <p role="status" class="vh">
        Loading Batches
      </p>
    </>
  ),
  errorComponent: (props) => {
    const search = Route.useSearch();
    return (
      <ReadErrorPage {...props} heading="Batches">
        <Show when={filterCount(search())}>
          <p>
            <Link class="stands-alone" to="/batches" search={{}}>
              Clear the filters
            </Link>
          </p>
        </Show>
        <Show when={search().after}>
          <p>
            <Link class="stands-alone" to="/batches" search={{ ...search(), after: undefined }}>
              Newest Batches
            </Link>
          </p>
        </Show>
      </ReadErrorPage>
    );
  },
  component: BatchList,
});

function BatchList() {
  const search = Route.useSearch();
  const list = useQuery(() =>
    orpc.batches.list.queryOptions({
      input: listInput(search()),
      refetchInterval: REFRESH_INTERVAL_MS,
    }),
  );
  const runners = useQuery(() => orpc.runners.list.queryOptions());
  const filtered = () => filterCount(search()) > 0;
  return (
    <>
      <Show when={list.isError || list.data.batches.length}>
        <p class="note">{timeZoneNote()}</p>
      </Show>
      <Show when={list.isError}>
        <FailedReadNotice
          what="The Batches"
          detail={hubFailureMessage(list.error)}
          failedAt={list.errorUpdatedAt}
          readAt={list.dataUpdatedAt}
        />
      </Show>
      <Show
        when={list.data.batches.length}
        fallback={
          <EmptyList
            to="/batches"
            filtered={filtered()}
            after={search().after}
            runners={runners.isError ? undefined : availableRunners(runners)}
          />
        }
      >
        <a class="vh skip-list" href="#batches-end">
          Skip to the end of the list
        </a>
        <BatchTable batches={list.data.batches} />
        <ListEnd
          to="/batches"
          after={search().after}
          filtered={filtered()}
          length={list.data.batches.length}
          older={list.data.hasMore ? list.data.batches.at(-1)?.id : undefined}
        />
      </Show>
    </>
  );
}

const columns = ["Batch", "Status", "Unfinished", "Failed", "Jobs", "Created by", "Created"];
function BatchTable(props: { batches?: ListedBatch[] }) {
  return (
    <div class="batch-list" aria-busy={props.batches ? undefined : "true"}>
      <table class="records" role="table" aria-hidden={props.batches ? undefined : "true"}>
        <caption class="vh">Batches</caption>
        <thead role="rowgroup">
          <tr role="row">
            {columns.map((column, i) => (
              <th role="columnheader" scope="col" class={{ num: i >= 2 && i <= 4 }}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">
          <Show
            when={props.batches}
            fallback={
              <Repeat count={6}>
                {() => (
                  <tr>
                    {columns.map((column, i) => (
                      <td class={{ "is-id": !i }} data-l={i ? column : undefined}>
                        <span class="sk" />
                      </td>
                    ))}
                  </tr>
                )}
              </Repeat>
            }
          >
            <For each={props.batches} keyed={(batch) => batch.id}>
              {(batch) => (
                <tr role="row">
                  <td role="cell" class="is-id">
                    <Link
                      to="/batches/$id"
                      params={{ id: batch().id }}
                      title={batch().id}
                      class="cut mono"
                    >
                      {batch().id}
                    </Link>
                  </td>
                  <td role="cell" data-l="Status">
                    <span class="batch-status">
                      <BatchStatus batch={batch()} />
                      <BatchConditions batch={batch()} />
                    </span>
                  </td>
                  <td role="cell" data-l="Unfinished" class="num">
                    {formatCount(unfinishedJobs(batch().jobCounts))}
                  </td>
                  <td role="cell" data-l="Failed" class="num">
                    {formatCount(batch().jobCounts.failed)}
                  </td>
                  <td role="cell" data-l="Jobs" class="num">
                    {formatCount(totalJobs(batch().jobCounts))}
                  </td>
                  <td role="cell" data-l="Created by" class="batch-submitter">
                    <JobSubmitter submitter={batch().submitter} inList />
                  </td>
                  <td role="cell" data-l="Created">
                    <Instant value={batch().createdAt} />
                  </td>
                </tr>
              )}
            </For>
          </Show>
        </tbody>
      </table>
    </div>
  );
}
