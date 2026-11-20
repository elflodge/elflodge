import { Outlet, createFileRoute, useChildMatches, useLocation } from "@tanstack/solid-router";
import { batchStatusSchema } from "contract";
import { createSignal } from "solid-js";
import * as z from "zod/mini";

import { BATCH_STATUS_WORDS } from "../../../batch.ts";
import {
  ListFilters,
  StatusFilters,
  optionalText,
  statusFilter,
} from "../../../components/ListFilters.tsx";
import { orpc } from "../../../query.ts";

const searchSchema = z.pipe(
  z.object({
    status: statusFilter(batchStatusSchema),
    labelKey: optionalText,
    labelValue: z.catch(z.optional(z.string()), undefined),
    after: optionalText,
  }),
  z.transform(({ labelKey, labelValue, ...statusAndCursor }) =>
    labelKey && labelValue !== undefined
      ? { ...statusAndCursor, labelKey, labelValue }
      : { ...statusAndCursor, labelKey: undefined, labelValue: undefined },
  ),
);
export type BatchesSearch = z.infer<typeof searchSchema>;

export function listInput(search: BatchesSearch) {
  return {
    status: search.status,
    after: search.after,
    labels: search.labelKey ? { [search.labelKey]: search.labelValue } : undefined,
  };
}

export function filterCount(search: BatchesSearch) {
  return Number(!!search.status?.length) + Number(!!search.labelKey);
}

export const Route = createFileRoute("/_signed-in/_member/batches")({
  validateSearch: searchSchema,
  component: Batches,
});

function Batches() {
  const appliedFilters = useLocation({
    select: ({ search }) => {
      const { after: _after, ...filters } = searchSchema.parse(search);
      return filters;
    },
  });
  const [draftValue, setDraftValue] = createSignal<string>();
  const failed = useChildMatches({
    select: (matches) => matches.some((match) => match.status === "error"),
  });

  return (
    <>
      <div hidden={failed()}>
        <div class="head">
          <h1>Batches</h1>
        </div>
        <ListFilters
          to="/batches"
          label="Filter the Batches"
          schema={searchSchema}
          filters={appliedFilters()}
          queryKey={(filters) => orpc.batches.list.queryKey({ input: listInput(filters) })}
          onReset={() => setDraftValue(undefined)}
          applied={filterCount(appliedFilters())}
          firstRow={
            <StatusFilters
              words={BATCH_STATUS_WORDS}
              statuses={batchStatusSchema.options}
              selected={appliedFilters().status}
            />
          }
        >
          <div class="filter-field">
            <label for="batch-label-key">Label key</label>
            <input
              id="batch-label-key"
              name="labelKey"
              defaultValue={appliedFilters().labelKey ?? ""}
              required={!!(draftValue() ?? appliedFilters().labelValue)}
            />
          </div>
          <div class="filter-field">
            <label for="batch-label-value">Label value</label>
            <input
              id="batch-label-value"
              name="labelValue"
              defaultValue={appliedFilters().labelValue ?? ""}
              onInput={({ currentTarget }) => setDraftValue(currentTarget.value)}
            />
          </div>
        </ListFilters>
      </div>
      <Outlet />
    </>
  );
}
