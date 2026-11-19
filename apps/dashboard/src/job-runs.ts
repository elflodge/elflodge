import {
  JOB_CANCELLED,
  JOB_FAILED,
  JOB_PAUSED,
  JOB_RECOVERED,
  JOB_RESUMED,
  JOB_STARTED,
  JOB_SUCCEEDED,
} from "contract";

import type { ReadJobEvent } from "./job-event-record.ts";
import { shortIds } from "./short-ids.ts";

export type TimedEvent = ReadJobEvent & { at: Date };
export interface LoadedRun {
  opening: TimedEvent;
  previousEnd?: TimedEvent;
  end?: TimedEvent;
  models: Set<string>;
  recoveries: TimedEvent[];
}

/** Derive only the relationships witnessed by this stretch, which may begin or end inside a run. */
export function groupJobEvents(events: ReadJobEvent[]) {
  const runIds = new Set<string>();
  const headings = new Map<number, LoadedRun>();
  const dayLines = new Set<number>();
  const subAgents = new Set<number>();
  const userLabels = new Map<number, "Input" | "Note at the resume">();
  let currentRun: LoadedRun | undefined;
  let countFrom: TimedEvent | undefined;
  let previousEnd: TimedEvent | undefined;
  let previousDay: string | undefined;
  let awaitingInput = false;

  for (const row of events) {
    if (row.runId) runIds.add(row.runId);
    if (row.ownerId !== undefined) subAgents.add(row.id);
    if (row.at) {
      const day = row.at.toDateString();
      if (previousDay && previousDay !== day) dayLines.add(row.id);
      previousDay = day;
    }
    if (row.runner && row.at) {
      const timed = { ...row, at: row.at };
      switch (row.kind) {
        case JOB_STARTED:
        case JOB_RESUMED:
          currentRun = { opening: timed, previousEnd, models: new Set(), recoveries: [] };
          headings.set(row.id, currentRun);
          previousEnd = undefined;
          countFrom = timed;
          awaitingInput = true;
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
          awaitingInput = false;
          break;
      }
    }
    if (!currentRun || currentRun.end) continue;
    if (row.providerModel) currentRun.models.add(row.providerModel);
    if (
      awaitingInput &&
      row.kind === "pi.user" &&
      row.conversationId === currentRun.opening.conversationId
    ) {
      userLabels.set(
        row.id,
        currentRun.opening.kind === JOB_STARTED ? "Input" : "Note at the resume",
      );
      awaitingInput = false;
    }
  }
  return {
    events,
    shortRunIds: shortIds([...runIds]),
    headings,
    currentRun,
    countFrom,
    dayLines,
    subAgents,
    userLabels,
  };
}
export type JobEventGroups = ReturnType<typeof groupJobEvents>;
