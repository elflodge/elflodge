import { access, copyFile, rm } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import { lifecycleOf } from "./entries.ts";
import { type ApiClient, type OneJob, startSystem, submitJob, untilStatus } from "./harness.ts";
import { untilAborted } from "./scripted-model.ts";

// A job's journal lost while its Runner is stopped, as when the job's files are deleted or
// restored from an older backup: the job is not carried on from where the journal ends, which
// would repeat its work, but fails, and its files stay for inspection.

const system = startSystem();

beforeAll(async () => {
  await system.start();
  await system.startRunner();
});
afterAll(() => system.stop());

const SUBMISSION = {
  input: "Count to a million.",
  files: [],
  outputContract: { schema: { type: "integer" } },
} satisfies OneJob;

/** Submits a job whose agent's model call runs until the Runner cuts it off, and waits until it runs. */
async function submitRunningJob(client: ApiClient) {
  system.model.setResponses([untilAborted, untilAborted]);
  const { id } = await submitJob(client, SUBMISSION);
  await untilStatus(client, id, "running");
  return id;
}

/** The job's journal on the Runner, with the files SQLite keeps beside it. */
function journalFiles(id: string) {
  const journal = path.join(path.dirname(system.workspace(id)), "journal.sqlite");
  return [journal, `${journal}-wal`, `${journal}-shm`];
}

async function removeJournal(id: string) {
  for (const file of journalFiles(id)) await rm(file, { force: true });
}

test("a job whose journal is restored from an earlier copy fails with journalLost and runs nothing", async () => {
  const client = await system.clientWithNewJobsKey();
  const id = await submitRunningJob(client);
  await system.stopRunner();
  const [journal = ""] = journalFiles(id);
  const copy = `${journal}.copy`;
  await copyFile(journal, copy);
  // Carried on from its journal, the job records its recovery, which the hub then holds.
  await system.startRunner();
  await expect
    .poll(async () => lifecycleOf((await client.jobs.events({ id })).events), { timeout: 20_000 })
    .toEqual(["elflodge.job.started", "elflodge.job.recovered"]);
  await system.stopRunner();
  await removeJournal(id);
  await copyFile(copy, journal);
  const calls = system.model.state.callCount;

  await system.startRunner();

  await untilStatus(client, id, "failed", 20_000);
  expect(await client.jobs.get({ id })).toMatchObject({
    failure: {
      reason: "journalLost",
      message: expect.stringMatching(/^The Runner's journal does not hold record \d+/),
    },
  });
  expect(system.model.state.callCount).toBe(calls);
  // Its events stay as the hub held them.
  const { events, status } = await client.jobs.events({ id });
  expect(status).toBe("failed");
  expect(lifecycleOf(events)).toEqual(["elflodge.job.started", "elflodge.job.recovered"]);
}, 60_000);

test("a job whose journal is missing fails with journalLost on its cancel too, keeping its files", async () => {
  const client = await system.clientWithNewJobsKey();
  const id = await submitRunningJob(client);
  await system.stopRunner();
  await removeJournal(id);
  expect(await client.jobs.cancel({ id })).toMatchObject({
    status: "running",
    pendingControl: { type: "cancel" },
  });

  await system.startRunner();

  await untilStatus(client, id, "failed", 20_000);
  const job = await client.jobs.get({ id });
  expect(job).toMatchObject({
    failure: {
      reason: "journalLost",
      message: expect.stringMatching(/^No journal on the Runner; the hub holds records up to \d+/),
    },
  });
  expect(job).not.toHaveProperty("pendingControl");
  await access(system.workspace(id));
}, 40_000);
