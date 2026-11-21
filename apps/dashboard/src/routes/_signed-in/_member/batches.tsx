import {
  Link,
  Outlet,
  createFileRoute,
  useChildMatches,
  useLocation,
} from "@tanstack/solid-router";
import { batchStatusSchema, LABEL_KEY_PATTERN, MAX_LABEL_NAME_LENGTH } from "contract";
import { createSignal } from "solid-js";
import * as z from "zod/mini";

import { BATCH_STATUS_WORDS } from "../../../batch.ts";
import { Field } from "../../../components/Field.tsx";
import { ListFilters, StatusFilters, statusFilter } from "../../../components/ListFilters.tsx";
import { memberPageHead } from "../../../page-title.ts";
import { orpc } from "../../../query.ts";
import { optionalText } from "../../../search-form.ts";

export const batchesSearchSchema = z.pipe(
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
export type BatchesSearch = z.infer<typeof batchesSearchSchema>;

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
  head: ({ match }) => memberPageHead(match.context, "Batches"),
  validateSearch: batchesSearchSchema,
  component: Batches,
});

function Batches() {
  const appliedFilters = useLocation({
    select: ({ search }) => {
      const { after: _after, ...filters } = batchesSearchSchema.parse(search);
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
          <div class="controls">
            <Link class="button primary" to="/batches/-/new">
              Submit a Batch
            </Link>
          </div>
        </div>
        <ListFilters
          to="/batches"
          label="Filter the Batches"
          schema={batchesSearchSchema}
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
          <Field class="filter-field" label="Label key">
            {(control) => (
              <input
                {...control}
                name="labelKey"
                pattern={LABEL_KEY_PATTERN.source}
                title={`Use a name of up to ${MAX_LABEL_NAME_LENGTH} letters, digits, hyphens, underscores or dots. Start and end with a letter or digit. An optional DNS prefix ends in a slash.`}
                defaultValue={appliedFilters().labelKey ?? ""}
                required={!!(draftValue() ?? appliedFilters().labelValue)}
              />
            )}
          </Field>
          <Field class="filter-field" label="Label value">
            {(control) => (
              <input
                {...control}
                name="labelValue"
                defaultValue={appliedFilters().labelValue ?? ""}
                onInput={({ currentTarget }) => setDraftValue(currentTarget.value)}
              />
            )}
          </Field>
        </ListFilters>
      </div>
      <Outlet />
    </>
  );
}
