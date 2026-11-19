import { Outlet, createFileRoute, useChildMatches, useNavigate } from "@tanstack/solid-router";
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

const searchSchema = z.pipe(
  z.object({
    status: statusFilter(batchStatusSchema),
    labelKey: optionalText,
    labelValue: z.catch(z.optional(z.string()), undefined),
    after: optionalText,
  }),
  z.transform((search) =>
    search.labelKey && search.labelValue !== undefined
      ? search
      : { ...search, labelKey: undefined, labelValue: undefined },
  ),
);
export type BatchesSearch = z.infer<typeof searchSchema>;

export function listInput(search: BatchesSearch) {
  return {
    status: search.status,
    after: search.after,
    labels:
      search.labelKey && search.labelValue !== undefined
        ? { [search.labelKey]: search.labelValue }
        : undefined,
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
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [labelKey, setLabelKey] = createSignal(() => search().labelKey ?? "");
  const [labelValue, setLabelValue] = createSignal(() => search().labelValue ?? "");
  const failed = useChildMatches({
    select: (matches) => matches.some((match) => match.status === "error"),
  });
  function submit(form: FormData) {
    const values = searchSchema.parse({
      ...Object.fromEntries(form),
      status: form.getAll("status"),
    });
    return navigate({
      to: "/batches",
      search: values,
    });
  }
  return (
    <>
      <div hidden={failed()}>
        <div class="head">
          <h1>Batches</h1>
        </div>
        <ListFilters
          to="/batches"
          label="Filter the Batches"
          submit={submit}
          applied={filterCount(search())}
          firstRow={
            <StatusFilters
              words={BATCH_STATUS_WORDS}
              statuses={batchStatusSchema.options}
              selected={search().status}
            />
          }
        >
          <div class="filter-field">
            <label for="batch-label-key">Label key</label>
            <input
              id="batch-label-key"
              name="labelKey"
              value={labelKey()}
              onInput={({ currentTarget }) => setLabelKey(currentTarget.value)}
              required={!!labelValue()}
            />
          </div>
          <div class="filter-field">
            <label for="batch-label-value">Label value</label>
            <input
              id="batch-label-value"
              name="labelValue"
              required={!!labelKey()}
              value={labelValue()}
              onInput={({ currentTarget }) => setLabelValue(currentTarget.value)}
            />
          </div>
        </ListFilters>
      </div>
      <Outlet />
    </>
  );
}
