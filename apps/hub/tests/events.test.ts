import { randomUUID } from "node:crypto";

import type { Job, JobEvent } from "contract";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import { entryKinds } from "./entries.ts";
import { type ApiClient, type OneJob, startSystem, submitJob, untilStatus } from "./harness.ts";
import { callTool, untilAborted } from "./scripted-model.ts";

// How callers read a job's events: in pages after the last event they have, during and after the
// run, until a page says no more will come.

const system = startSystem();

beforeAll(async () => {
  await system.start();
  await system.startRunner();
});
afterAll(() => system.stop());

const SUBMISSION = {
  input: "Greet the reader.",
  files: [],
  outputContract: {
    schema: {
      type: "object",
      properties: { greeting: { type: "string" } },
      required: ["greeting"],
    },
  },
} satisfies OneJob;

/** An ended job's events from the start, read `limit` at a time until a page has no more. */
async function readAll(client: ApiClient, job: Job, limit: number) {
  const events: JobEvent[] = [];
  for (;;) {
    const page = await client.jobs.events({ id: job.id, after: events.at(-1)?.id ?? 0, limit });
    events.push(...page.events);
    if (!page.hasMore) {
      expect(page.job).toEqual(job);
      return events;
    }
    expect(page).not.toHaveProperty("job");
  }
}

test("a finished job's events, read in pages, run from its start to its end without gaps or repeats", async () => {
  system.model.setResponses([
    callTool("write", { path: "out/greeting.txt", content: "Hello" }),
    callTool("submit_output", { value: { greeting: "Hello" } }),
  ]);
  const client = await system.clientWithNewJobsKey();
  const { id } = await submitJob(client, SUBMISSION);
  await expect
    .poll(async () => (await client.jobs.get({ id })).status, { timeout: 10_000 })
    .toBe("succeeded");

  const job = await client.jobs.get({ id });
  expect(job).toMatchObject({ status: "succeeded", output: { greeting: "Hello" } });
  const newest = await client.jobs.events({ id, order: "desc", limit: 1 });
  expect(newest.job).toEqual(job);
  const events = await readAll(client, job, 100);
  expect(await readAll(client, job, 2)).toEqual(events);
  expect(events[0]).toMatchObject({ type: "conversation" });
  expect(entryKinds(events)).toContain("pi.tool-result");
  expect(entryKinds(events)[0]).toBe("elflodge.job.started");
  expect(events.at(-1)).toMatchObject({
    type: "entry",
    record: { kind: "elflodge.job.succeeded", data: { output: { greeting: "Hello" } } },
  });
});

test("reading the events of a job the hub does not have fails with 404", async () => {
  const client = await system.clientWithNewJobsKey();
  await expect(client.jobs.events({ id: randomUUID() })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("a member following a paused job sees a hub-side cancel at the same Event", async () => {
  system.model.setResponses([untilAborted]);
  const client = await system.clientWithNewJobsKey();
  const { id } = await submitJob(client, SUBMISSION);
  await expect
    .poll(async () => entryKinds((await client.jobs.events({ id })).events), { timeout: 10_000 })
    .toContain("elflodge.job.started");

  await client.jobs.pause({ id });
  await untilStatus(client, id, "paused");
  const { events } = await client.jobs.events({ id });
  const page = await client.jobs.events({ id, after: events.at(-1)?.id ?? 0 });
  expect(page).toMatchObject({ events: [], hasMore: false, job: { status: "paused" } });
  const cancelled = await client.jobs.cancel({ id });
  expect(cancelled.status).toBe("cancelled");
  expect(await client.jobs.events({ id, after: events.at(-1)?.id ?? 0 })).toMatchObject({
    events: [],
    hasMore: false,
    job: { status: "cancelled", endedAt: cancelled.endedAt },
  });
});
