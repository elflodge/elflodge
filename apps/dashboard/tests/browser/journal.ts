import type { Job, JobEvent, JobEventsPage } from "contract";
import type { BrowserPage } from "vite-plus/test/browser/context";

import type { Hub } from "../hub.ts";
import {
  NOW,
  ago,
  aConversation,
  aFailure,
  aJob,
  aMessage,
  aRunner,
  aStart,
  aToolResult,
  failedFor,
  sentTo,
} from "../records.ts";
import type { Open, PageOptions } from "./dashboard.tsx";

// The job page's records and reads, for job.test.ts and job.touch.test.ts.

export const RUNNER = aRunner("test-runner");

/** What a job that started a minute ago on `RUNNER` reports beside its status. */
export const STARTED = {
  startedAt: ago(60_000),
  runner: sentTo(RUNNER),
  lastReportedAt: ago(5_000),
};

/** The job with the Custom ID `customId`, running on `RUNNER`. */
export function runningJob(customId: string): Job {
  return aJob(customId, { status: "running", ...STARTED });
}

/** The job with the Custom ID `customId`, ended with `output`. */
export function succeededJob(customId: string, output: unknown): Job {
  return aJob(customId, { status: "succeeded", output, ...STARTED, endedAt: NOW });
}

/**
 * A started job's journal: its conversation, its start, a call of `bash` that printed 66 lines at
 * Event 10, then `entries - 1` messages, Events 20, 30 and on.
 */
export function history(entries: number): JobEvent[] {
  return [
    aConversation(1),
    aStart(2),
    aToolResult(10, 66),
    ...Array.from({ length: entries - 1 }, (_, index) => aMessage((index + 2) * 10)),
  ];
}

/** A job and its journal as the hub holds them, which a test changes between steps. */
export interface Journal {
  job: Job;
  events: JobEvent[];
}

/**
 * A page of `journal`'s Events as the hub reads it: past the cursor in the order asked, with the
 * job where the hub's page carries it, from the newest end and at the end of an ascending read.
 */
export function eventsPage(
  journal: Journal,
  input: { order?: "asc" | "desc"; after: number; limit: number },
): JobEventsPage {
  const newestFirst = input.order === "desc";
  const past = (newestFirst ? journal.events.toReversed() : journal.events).filter(
    ({ id }) => input.after === 0 || (newestFirst ? id < input.after : id > input.after),
  );
  const hasMore = past.length > input.limit;
  const carriesJob = newestFirst ? input.after === 0 : !hasMore;
  return {
    events: past.slice(0, input.limit),
    hasMore,
    status: journal.job.status,
    ...(carriesJob ? { job: journal.job } : {}),
  };
}

/** Has the stand-in answer the job's reads from `journal` as it stands at each read. */
export function serve(hub: Hub, journal: Journal) {
  hub.jobs.get.answers(() => journal.job);
  hub.jobs.events.answers((input) => eventsPage(journal, input));
}

/** Opens `journal`'s job, which the stand-in serves from it. */
export async function openJob(hub: Hub, open: Open, journal: Journal, options?: PageOptions) {
  serve(hub, journal);
  return open(`jobs/${journal.job.id}`, options);
}

/** Its status as the page shows it. */
export const statusWord = (page: BrowserPage) => page.getByCSS(".status-lg");

/** The Output the page shows, as code. */
export const output = (page: BrowserPage) =>
  page.getByLabelText("Output", { exact: true }).getByCSS("code");

/** A job that failed when its model calls' cost reached its budget, and its journal. */
export function spentBudget(customId: string): Journal {
  const failure = failedFor("modelBudgetExceeded");
  const job = aJob(customId, {
    status: "failed",
    failure,
    ...STARTED,
    endedAt: ago(30_000),
    modelBudgetUsd: 0.000001,
    usage: { totalTokens: 1200, cost: { totalUsd: 0.000004 } },
  });
  return { job, events: [aConversation(1), aStart(2), aFailure(3, failure)] };
}
