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
 * Moves what the hub recorded of the Runner `runnerId`, or of the job `jobId`, three minutes back;
 * returns when the job's status became unknown, `GONE_AFTER_MS` after that.
 */
async function threeMinutesPass(which: { runnerId: string } | { jobId: string }) {
  await using database = openDatabase(inject("databaseUrl"));
  const db = database.withSchema(DB_SCHEMA);
  const back = new Date(Date.now() - 3 * 60_000);
  if ("runnerId" in which) {
    await db
      .updateTable("runner")
      .set({ lastSeenAt: back })
      .where("id", "=", RunnerId(which.runnerId))
      .execute();
  } else {
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
  }
  return new Date(back.getTime() + GONE_AFTER_MS);
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
  const { client, job, runnerId, socket } = await placedJob();
  expect(await client.jobs.get({ id: job.id })).not.toHaveProperty("statusUnknown");

  const since = await threeMinutesPass({ runnerId });

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
  const unknown = await client.jobs.list({ batchId: read.batchId, statusUnknown: true });
  expect(unknown.jobs.map(({ id }) => id)).toEqual([job.id]);
  const known = await client.jobs.list({ batchId: read.batchId, statusUnknown: false });
  expect(known.jobs).toEqual([]);
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
