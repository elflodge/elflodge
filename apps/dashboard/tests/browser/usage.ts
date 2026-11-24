import { aUsageReport, usageCount } from "../records.ts";

// The Usage page's reports, for its tests, which are in a file per member and per time zone.

/** A week's report by Batch: two job ends on one day, one of which used nothing. */
export function byBatch(costUsd: number) {
  return aUsageReport(
    { from: "2026-11-17", days: { "2026-11-20": usageCount(2, 12_345, costUsd) } },
    {
      groupBy: "batch",
      groups: [
        { batchId: "statements", ...usageCount(1, 12_345, costUsd) },
        { batchId: "receipts", ...usageCount(1) },
      ],
    },
  );
}
