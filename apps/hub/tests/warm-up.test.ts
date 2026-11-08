import { setTimeout } from "node:timers/promises";

import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import { type ApiClient, startSystem, untilStatus } from "./harness.ts";
import { callTool, providerError, untilAborted } from "./scripted-model.ts";

// A Runner starts one of several jobs that share their instructions and Output contract, and
// holds the others until that job's first model call returns, so their calls read the prompt the
// first one cached. These tests hold the first call open; the cap and the warmth's expiry are
// timed in the Runner's own tests.

const system = startSystem();

beforeAll(async () => {
  await system.start();
  await system.startRunner();
});
afterAll(() => system.stop());

/**
 * Adds `count` jobs to a new Batch whose instructions no other test uses, so no earlier call has
 * warmed them, and answers their IDs in the order they were added.
 */
async function addJobs(client: ApiClient, count: number, runTimeoutSeconds?: number) {
  const batch = await client.batches.create({
    agent: {
      instructions: `Return an integer. (${crypto.randomUUID()})`,
      outputContract: { schema: { type: "integer" } },
      ...(runTimeoutSeconds === undefined ? {} : { runTimeoutSeconds }),
    },
    breaker: false,
  });
  const { jobs } = await client.batches.addJobs({
    id: batch.id,
    jobs: Array.from({ length: count }, (_, index) => ({
      customId: `job-${index}`,
      input: `Job ${index}.`,
      files: [],
    })),
  });
  return jobs.map(({ job }) => job.id);
}

/** A first model call that returns only once the test releases it, with `response`. */
function heldCall(response: ReturnType<typeof callTool>) {
  const { promise, resolve } = Promise.withResolvers<void>();
  return {
    release: resolve,
    respond: async () => {
      await promise;
      return response;
    },
  };
}

/** The IDs of the jobs among `ids` whose agents have started. */
async function started(client: ApiClient, ids: string[]) {
  const jobs = await Promise.all(ids.map((id) => client.jobs.get({ id })));
  return jobs.filter((job) => job.startedAt !== null).map((job) => job.id);
}

test.for([
  // An invalid output keeps the first job working, so only its call's return releases the others.
  ["completes", callTool("submit_output", { value: "not an integer" })],
  ["fails", providerError("429 rate limit exceeded")],
] as const)(
  "the jobs sharing a first job's prompt start once its first model call %s, before it ends",
  async ([, response]) => {
    const client = await system.clientWithNewJobsKey();
    const firstCall = heldCall(response);
    system.model.setResponses([firstCall.respond, untilAborted, untilAborted, untilAborted]);
    const ids = await addJobs(client, 3);

    await expect.poll(() => started(client, ids)).toHaveLength(1);
    const [firstJob = ""] = await started(client, ids);
    await setTimeout(1_000);
    expect(await started(client, ids)).toEqual([firstJob]);
    for (const id of ids.filter((other) => other !== firstJob)) {
      expect(await client.jobs.events({ id })).toMatchObject({ events: [] });
    }

    firstCall.release();
    await expect.poll(() => started(client, ids)).toHaveLength(3);
    expect((await client.jobs.get({ id: firstJob })).status).toBe("running");
    await Promise.all(ids.map((id) => client.jobs.cancel({ id })));
  },
);

test("a waiting job that is paused or cancelled does not start, and the others still do", async () => {
  const client = await system.clientWithNewJobsKey();
  const firstCall = heldCall(callTool("submit_output", { value: "not an integer" }));
  system.model.setResponses([firstCall.respond, untilAborted, untilAborted]);
  const ids = await addJobs(client, 4);
  await expect.poll(() => started(client, ids)).toHaveLength(1);
  const [firstJob = ""] = await started(client, ids);
  const [paused = "", cancelled = "", waiting = ""] = ids.filter((other) => other !== firstJob);

  await client.jobs.pause({ id: paused });
  await client.jobs.cancel({ id: cancelled });
  await untilStatus(client, paused, "paused");
  await untilStatus(client, cancelled, "cancelled");
  firstCall.release();

  await expect.poll(() => started(client, ids)).toEqual(expect.arrayContaining([waiting]));
  expect(await started(client, ids)).toHaveLength(2);
  expect(await client.jobs.get({ id: paused })).toMatchObject({
    status: "paused",
    startedAt: null,
  });
  expect(await client.jobs.get({ id: cancelled })).toMatchObject({
    status: "cancelled",
    startedAt: null,
  });
  await Promise.all([firstJob, paused, waiting].map((id) => client.jobs.cancel({ id })));
});

test("jobs with another prompt do not wait for a warm-up", async () => {
  const client = await system.clientWithNewJobsKey();
  const firstCall = heldCall(callTool("submit_output", { value: "not an integer" }));
  system.model.setResponses([firstCall.respond, untilAborted, untilAborted]);
  const warming = await addJobs(client, 2);
  await expect.poll(() => started(client, warming)).toHaveLength(1);

  const other = await addJobs(client, 1);
  await expect.poll(() => started(client, other)).toHaveLength(1);
  expect(await started(client, warming)).toHaveLength(1);

  firstCall.release();
  await expect.poll(() => started(client, warming)).toHaveLength(2);
  await Promise.all([...warming, ...other].map((id) => client.jobs.cancel({ id })));
});

test("a first job that ends releases the others, whose run timeout starts only with their agents", async () => {
  const client = await system.clientWithNewJobsKey();
  system.model.setResponses([untilAborted, untilAborted]);
  const ids = await addJobs(client, 2, 1);

  for (const id of ids) await untilStatus(client, id, "failed");
  const [firstJob, follower] = (
    await Promise.all(ids.map((id) => client.jobs.get({ id })))
  ).toSorted((a, b) => (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0));
  expect(firstJob).toMatchObject({ failure: { reason: "runTimedOut" } });
  // The follower waited out the first job's run, and then had its own whole second.
  expect(follower).toMatchObject({ failure: { reason: "runTimedOut" } });
  expect(follower?.startedAt?.getTime()).toBeGreaterThanOrEqual(firstJob?.endedAt?.getTime() ?? 0);
  expect(
    (follower?.endedAt?.getTime() ?? 0) - (follower?.startedAt?.getTime() ?? 0),
  ).toBeGreaterThanOrEqual(1_000);
});
