import { usageGroupBySchema, type UsageGroupBy } from "contract";
import * as z from "zod/mini";

export const groupings = {
  batch: { option: "Batch", heading: "By Batch", column: "Batch", one: "Batch", many: "Batches" },
  submitter: {
    option: "Submitter",
    heading: "By submitter",
    column: "Submitter",
    one: "submitter",
    many: "submitters",
  },
  runner: {
    option: "Runner",
    heading: "By Runner",
    column: "Runner",
    one: "Runner",
    many: "Runners",
  },
  status: {
    option: "Status",
    heading: "By status",
    column: "Status",
    one: "status",
    many: "statuses",
  },
  label: {
    option: "Label",
    heading: "By the Label",
    column: "Value of",
    one: "value",
    many: "values",
  },
} as const;

function byLabel(by: UsageGroupBy): by is `label:${string}` {
  return by.startsWith("label:");
}

// A Label address can carry a key the hub will refuse. Keep it available for correction.
const displayedGrouping = z.union([usageGroupBySchema, z.templateLiteral(["label:", z.string()])]);

/** The form and ledger use the same grouping; only a Label grouping also names a key. */
export function usageGrouping(value: string | string[]) {
  const result = displayedGrouping.safeParse(value);
  if (!result.success) return undefined;
  const by = result.data;
  return byLabel(by)
    ? { by: "label" as const, labelKey: by.slice("label:".length) }
    : { by, labelKey: undefined };
}
