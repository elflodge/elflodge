import type { Batch, BatchStatus } from "contract";

export const BATCH_STATUS_WORDS: Record<BatchStatus, string> = {
  active: "Active",
  paused: "Paused",
  cancelled: "Cancelled",
};

export function unfinishedJobs(counts: Batch["jobCounts"]) {
  return counts.queued + counts.running + counts.paused;
}

export function totalJobs(counts: Batch["jobCounts"]) {
  return unfinishedJobs(counts) + counts.succeeded + counts.failed + counts.cancelled;
}
