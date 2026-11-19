import { afterAll, beforeAll, expect, inject, test } from "vite-plus/test";

import { DB_SCHEMA, openDatabase } from "../src/db/database.ts";
import { JobId, RunnerId } from "../src/db/types.ts";
import { GONE_AFTER_MS } from "../src/runners.ts";
import { type OneJob, protocolClient, startSystem, submitJob } from "./harness.ts";

// A job sent to a Runner keeps the last status its Runner confirmed, and shows `statusUnknown` once
// the hub has heard nothing of it for two minutes: from its Runner at all, or about this job. The
// jobs are placed on a socket that speaks the protocol directly, and the minutes pass by moving the
// recorded times back.

const system = startSystem();

beforeAll(() => system.start());
afterAll(() => system.stop());

const SUBMISSION = {
  input: "Count to three.",
  files: [],
  outputContract: { schema: { type: "integer" } },
} satisfies OneJob;

/**
 * Moves what the hub recorded of the job `jobId`, and of the Runner `runnerId` when given, three
 * minutes back; returns when the job's status became unknown, `GONE_AFTER_MS` after that.
 */
async function threeMinutesPass(which: { jobId: string; runnerId?: string }) {
  await using database = openDatabase(inject("databaseUrl"));
  const db = database.withSchema(DB_SCHEMA);
  const back = new Date(Date.now() - 3 * 60_000);
  await db
    .updateTable("job")
    .set({ placedAt: back })
    .where("id", "=", JobId(which.jobId))
    .execute();
  await db
    .updateTable("jobProgress")
    .set({ lastReportedAt: back })
    .where("jobId", "=", JobId(which.jobId))
    .execute();
  if (which.runnerId !== undefined) await runnerSeenAt(which.runnerId, back);
  return new Date(back.getTime() + GONE_AFTER_MS);
}

/** Records the Runner `runnerId` as last seen at `at`. */
async function runnerSeenAt(runnerId: string, at: Date) {
  await using database = openDatabase(inject("databaseUrl"));
  await database
    .withSchema(DB_SCHEMA)
    .updateTable("runner")
    .set({ lastSeenAt: at })
    .where("id", "=", RunnerId(runnerId))
    .execute();
}

/** Submits a job and places it on a new Runner's socket, which holds it without reporting. */
async function placedJob() {
  const client = await system.clientWithNewJobsKey();
  const job = await submitJob(client, SUBMISSION);
  const { runnerId, socket } = await system.connectRunner();
  const runner = protocolClient(socket);
  const { runs } = await runner.request("sync", { held: [], free: 1 }, 10_000);
  const [run] = runs;
  if (run?.jobId !== job.id) throw new Error("The job was not placed");
  return { client, job, runnerId, socket, runner, run: { jobId: run.jobId, runId: run.runId } };
}

test("a job whose Runner goes unheard shows its status unknown, counted and listed", async () => {
  const { client, job, runnerId, socket, runner } = await placedJob();
  expect(await client.jobs.get({ id: job.id })).not.toHaveProperty("statusUnknown");

  const since = await threeMinutesPass({ jobId: job.id, runnerId });

  const read = await client.jobs.get({ id: job.id });
  expect(read).toMatchObject({
    status: "queued",
    statusUnknown: { reason: "runnerDisconnected", since },
    runner: { id: runnerId, connected: false },
  });
  if (read.batchId === undefined) throw new Error("The job has no Batch");
  expect(await client.batches.get({ id: read.batchId })).toMatchObject({
    jobCounts: { queued: 1 },
    statusUnknownJobs: 1,
  });
  const listed = await client.batches.list({});
  expect(listed.batches.find(({ id }) => id === read.batchId)).toMatchObject({
    statusUnknownJobs: 1,
  });
  const unknown = await client.jobs.list({ batchId: read.batchId, statusUnknown: true });
  expect(unknown.jobs.map(({ id }) => id)).toEqual([job.id]);
  const known = await client.jobs.list({ batchId: read.batchId, statusUnknown: false });
  expect(known.jobs).toEqual([]);

  // Heard from again without reporting the job: the reason changes, the time it began does not.
  await runner.request("hello", { name: "host-1" }, 10_000);
  expect(await client.jobs.get({ id: job.id })).toMatchObject({
    statusUnknown: { reason: "notReported", since },
    runner: { connected: true },
  });
  socket.close(1000);
});

test("the Organization's unfinished jobs are counted by status, with those whose status is unknown", async () => {
  const client = await system.clientWithNewJobsKey();
  // Other tests' jobs count too, so only the change is the test's own.
  const before = await client.jobs.counts({});
  /** Expects the counts to have changed from `before` by these differences. */
  async function expectChange({ queued = 0, running = 0, unknownQueued = 0, unknownRunning = 0 }) {
    expect(await client.jobs.counts({})).toEqual({
      jobCounts: {
        queued: before.jobCounts.queued + queued,
        running: before.jobCounts.running + running,
        paused: before.jobCounts.paused + 1,
      },
      statusUnknownJobCounts: {
        queued: before.statusUnknownJobCounts.queued + unknownQueued,
        running: before.statusUnknownJobCounts.running + unknownRunning,
      },
    });
  }

  const { job, runnerId, socket, runner, run } = await placedJob();
  const paused = await submitJob(client, SUBMISSION);
  await client.jobs.pause({ id: paused.id });
  await expectChange({ queued: 1 });

  // Unheard before its first report: still counted as queued, and as unknown.
  await threeMinutesPass({ jobId: job.id, runnerId });
  await expectChange({ queued: 1, unknownQueued: 1 });

  // Its start, reported, moves it to running and confirms it.
  const started = {
    id: 1,
    type: "entry",
    record: {
      kind: "elflodge.job.started",
      data: { timestamp: Date.now(), runId: run.runId, runnerVersion: "0.0.0" },
    },
  } as const;
  await runner.request(
    "report",
    {
      held: [run],
      free: 0,
      deleted: [],
      jobs: [{ ...run, intent: "run", position: 0, events: [started] }],
    },
    10_000,
  );
  await expectChange({ running: 1 });

  await threeMinutesPass({ jobId: job.id });
  await expectChange({ running: 1, unknownRunning: 1 });

  // A stray parameter is refused, not answered with counts that would read as the Batch's.
  const stray = await system.hub.fetch(`/jobs/counts?batchId=${paused.batchId}`, {
    headers: { "x-api-key": await system.newJobsKey() },
  });
  expect(stray.status).toBe(400);
  socket.close(1000);
});

test("a job its connected Runner stops reporting shows its status unknown until it reports", async () => {
  const { client, job, socket, runner, run } = await placedJob();

  const since = await threeMinutesPass({ jobId: job.id });

  expect(await client.jobs.get({ id: job.id })).toMatchObject({
    status: "queued",
    statusUnknown: { reason: "notReported", since },
    runner: { connected: true },
  });

  // A report with nothing new, as a job still preparing sends, says the job is held.
  await runner.request(
    "report",
    {
      held: [run],
      free: 0,
      deleted: [],
      jobs: [{ ...run, intent: "run", position: 0, events: [] }],
    },
    10_000,
  );

  const read = await client.jobs.get({ id: job.id });
  expect(read).not.toHaveProperty("statusUnknown");
  expect(read.lastReportedAt?.getTime()).toBeGreaterThan(Date.now() - 60_000);
  socket.close(1000);
});
