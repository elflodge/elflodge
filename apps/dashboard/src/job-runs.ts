import {
  JOB_CANCELLED,
  JOB_FAILED,
  JOB_PAUSED,
  JOB_RECOVERED,
  JOB_RESUMED,
  JOB_STARTED,
  JOB_SUCCEEDED,
} from "contract";

import { LOCAL_ISO_DATE } from "./format.ts";
import type { ReadJobEvent } from "./job-event-record.ts";
import type { JobLifecycle } from "./job-lifecycle.ts";
import { shortIds } from "./short-ids.ts";

export type TimedEvent = ReadJobEvent & { at: Date; lifecycle: JobLifecycle };
export interface LoadedRun {
  opening: TimedEvent;
  previousEnd?: TimedEvent;
  end?: TimedEvent;
  models: Set<string>;
  recoveries: TimedEvent[];
}

/** Derive only the relationships witnessed by the loaded Events, which may begin or end inside a run. */
export function groupJobEvents(events: ReadJobEvent[], firstHeadEventId: number | undefined) {
  const runIds = new Set<string>();
  const headings = new Map<number, LoadedRun>();
  const dayLines = new Set<number>();
  const subAgents = new Set<number>();
  let currentRun: LoadedRun | undefined;
  let countFrom: TimedEvent | undefined;
  let previousEnd: TimedEvent | undefined;
  let previousDay: string | undefined;

  for (const row of events) {
    if (row.runId) runIds.add(row.runId);
    if (row.ownerId !== undefined) subAgents.add(row.id);
    if (row.at) {
      const day = LOCAL_ISO_DATE.format(row.at);
      if (previousDay && previousDay !== day) dayLines.add(row.id);
      previousDay = day;
    }
    if (row.lifecycle && row.at) {
      const timed = { ...row, at: row.at, lifecycle: row.lifecycle };
      switch (row.kind) {
        case JOB_STARTED:
        case JOB_RESUMED:
          currentRun = { opening: timed, previousEnd, models: new Set(), recoveries: [] };
          headings.set(row.id, currentRun);
          previousEnd = undefined;
          countFrom = timed;
          break;
        case JOB_RECOVERED:
          countFrom = timed;
          currentRun?.recoveries.push(timed);
          break;
        case JOB_PAUSED:
        case JOB_SUCCEEDED:
        case JOB_FAILED:
        case JOB_CANCELLED:
          if (currentRun) currentRun.end = timed;
          previousEnd = timed;
          countFrom = undefined;
          break;
      }
    }
    if (!currentRun || currentRun.end) continue;
    if (row.providerModel) currentRun.models.add(row.providerModel);
  }
  // Earlier history expands below the paging button. A newly revealed opening or previous end
  // belongs in the timeline without adding to the sentence or timeout above it.
  const forHead = (event?: TimedEvent) =>
    event && firstHeadEventId !== undefined && event.id >= firstHeadEventId ? event : undefined;
  return {
    events,
    shortRunIds: shortIds([...runIds]),
    headings,
    currentRun,
    sentenceRun:
      currentRun && forHead(currentRun.opening)
        ? { ...currentRun, previousEnd: forHead(currentRun.previousEnd) }
        : undefined,
    countFrom: forHead(countFrom),
    dayLines,
    subAgents,
  };
}
export type JobEventGroups = ReturnType<typeof groupJobEvents>;
