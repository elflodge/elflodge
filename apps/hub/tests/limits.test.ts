import { ConfigProvider } from "effect";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import { hubSettings, readConfig } from "../src/settings.ts";
import { type OneJob, startSystem, submitJob, untilStatus } from "./harness.ts";
import { callTool, untilAborted } from "./scripted-model.ts";

// Batch creation applies the hub's defaults. Added jobs inherit their Batch's limits, and a resume
// keeps the job's stored value for each omitted limit. Resume can raise a limit that stopped the job.

const system = startSystem({
  hubVars: {
    JOB_RUN_TIMEOUT_SECONDS_DEFAULT: "600",
    JOB_RUN_TIMEOUT_SECONDS_MAX: "3600",
    JOB_MODEL_BUDGET_USD_DEFAULT: "0.75",
    JOB_MODEL_BUDGET_USD_MAX: "5",
  },
});

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

test("the hub applies the defaults and accepts limits up to the maxima it reports", async () => {
  const client = await system.clientWithNewJobsKey();
  const { runTimeoutSeconds, modelBudgetUsd } = await client.jobs.limits({});
  expect(runTimeoutSeconds).toEqual({ default: 600, max: 3600 });
  expect(modelBudgetUsd).toEqual({ default: 0.75, max: 5 });
  system.model.setResponses([callTool("submit_output", { value: 1_000_000 })]);
  const job = await submitJob(client, SUBMISSION);
  expect(await client.jobs.get({ id: job.id })).toMatchObject({
    runTimeoutSeconds: runTimeoutSeconds.default,
    modelBudgetUsd: modelBudgetUsd.default,
  });
  // Its model call is made before the next test gives the model other responses.
  await untilStatus(client, job.id, "succeeded");
  const agent = {
    outputContract: SUBMISSION.outputContract,
    runTimeoutSeconds: runTimeoutSeconds.max,
    modelBudgetUsd: modelBudgetUsd.max,
  };
  await client.batches.create({ agent });
  await expect(
    client.batches.create({ agent: { ...agent, runTimeoutSeconds: runTimeoutSeconds.max + 1 } }),
  ).rejects.toMatchObject({
    cause: { status: 400, detail: expect.stringContaining("runTimeoutSeconds") },
  });
  await expect(
    client.batches.create({
      agent: {
        outputContract: { schema: { type: "array" } },
        modelBudgetUsd: modelBudgetUsd.max + 0.01,
      },
    }),
  ).rejects.toMatchObject({
    cause: {
      status: 400,
      errors: [{ pointer: "/agent/outputContract/schema" }, { pointer: "/agent/modelBudgetUsd" }],
    },
  });
});

test("a repeat keeps the limits accepted for a Batch before the maximum was lowered", async () => {
  const agent = { outputContract: SUBMISSION.outputContract, modelBudgetUsd: 5 };
  const jobs = [{ customId: "count", input: SUBMISSION.input }];
  system.model.setResponses([callTool("submit_output", { value: 1 })]);
  const created = await system.owner().batches.create({ agent, jobs });
  const jobId = created.jobs[0]?.job.id;
  if (!jobId) throw new Error("The creation returned no job");
  await untilStatus(system.owner(), jobId, "succeeded");

  const lowered = startSystem({ hubVars: { JOB_MODEL_BUDGET_USD_MAX: "4" } });
  await lowered.start({ keepDatabase: true });
  try {
    const client = lowered.owner();
    await expect(client.batches.create({ agent })).rejects.toMatchObject({
      cause: { status: 400 },
    });
    await expect(
      client.batches.create({ id: created.id, agent, jobs: [{ customId: "no-input" }] }),
    ).rejects.toMatchObject({
      cause: { status: 400, errors: [{ pointer: "/jobs/0/input" }] },
    });
    await expect(
      client.batches.create({ id: created.id, agent: { ...agent, modelBudgetUsd: 6 } }),
    ).rejects.toMatchObject({
      cause: { status: 422, errors: [{ pointer: "/id" }] },
    });
    expect(await client.batches.create({ id: created.id, agent })).toMatchObject({
      id: created.id,
      jobs: [],
    });
    expect(await client.batches.create({ id: created.id, agent, jobs })).toMatchObject({
      jobs: [{ created: false, job: { id: jobId } }],
    });
    expect(await client.jobs.get({ id: jobId })).toMatchObject({ modelBudgetUsd: 5 });
  } finally {
    await lowered.stop();
  }
});

test("a job whose run passes its timeout fails, and a resume with a longer one carries it on", async () => {
  const client = await system.clientWithNewJobsKey();
  system.model.setResponses([untilAborted]);
  const { id } = await submitJob(client, { ...SUBMISSION, runTimeoutSeconds: 1 });
  await untilStatus(client, id, "failed");
  expect(await client.jobs.get({ id })).toMatchObject({
    failure: { reason: "runTimedOut" },
    runTimeoutSeconds: 1,
  });

  system.model.setResponses([callTool("submit_output", { value: 1_000_000 })]);
  expect(await client.jobs.resume({ id, runTimeoutSeconds: 10 * 60 })).toMatchObject({
    status: "queued",
    runTimeoutSeconds: 10 * 60,
  });
  await untilStatus(client, id, "succeeded");
  const succeeded = await client.jobs.get({ id });
  expect(succeeded).toMatchObject({ output: 1_000_000 });
  expect(succeeded).not.toHaveProperty("failure");
});

test("a resume repeating a running job's limits returns it, and one changing them is refused", async () => {
  const client = await system.clientWithNewJobsKey();
  system.model.setResponses([untilAborted]);
  const { id } = await submitJob(client, {
    ...SUBMISSION,
    runTimeoutSeconds: 600,
    modelBudgetUsd: 1,
  });
  expect(await client.jobs.resume({ id, runTimeoutSeconds: 600, modelBudgetUsd: 1 })).toMatchObject(
    { runTimeoutSeconds: 600, modelBudgetUsd: 1 },
  );
  await expect(client.jobs.resume({ id, runTimeoutSeconds: 601 })).rejects.toMatchObject({
    code: "CONFLICT",
  });
  await client.jobs.cancel({ id });
  await untilStatus(client, id, "cancelled");
});

test("a job whose model cost reaches its budget fails, and only a higher budget carries it on", async () => {
  const client = await system.clientWithNewJobsKey();
  // The first call costs more than the budget, so the agent's next request is never made.
  system.model.setResponses([callTool("bash", { command: "true" })]);
  const { id } = await submitJob(client, { ...SUBMISSION, modelBudgetUsd: 0.000001 });
  await untilStatus(client, id, "failed");
  const failed = await client.jobs.get({ id });
  expect(failed).toMatchObject({ failure: { reason: "modelBudgetExceeded" } });
  expect(failed.usage.cost.totalUsd).toBeGreaterThan(0.000001);

  await expect(client.jobs.resume({ id })).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(
    client.jobs.resume({ id, modelBudgetUsd: failed.usage.cost.totalUsd }),
  ).rejects.toMatchObject({ code: "CONFLICT" });

  system.model.setResponses([callTool("submit_output", { value: 1_000_000 })]);
  expect(await client.jobs.resume({ id, modelBudgetUsd: 1 })).toMatchObject({
    status: "queued",
    modelBudgetUsd: 1,
  });
  await untilStatus(client, id, "succeeded");
});

test("the hub refuses settings whose default limit is above its maximum", () => {
  const env = { BETTER_AUTH_SECRET: "secret", HUB_URL: "http://localhost" };
  expect(() =>
    readConfig(
      hubSettings,
      ConfigProvider.fromEnv({
        env: { ...env, JOB_RUN_TIMEOUT_SECONDS_DEFAULT: String(25 * 60 * 60) },
      }),
    ),
  ).toThrow(
    "JOB_RUN_TIMEOUT_SECONDS_DEFAULT: Expected a value less than or equal to JOB_RUN_TIMEOUT_SECONDS_MAX (86400), got 90000",
  );
  expect(() =>
    readConfig(
      hubSettings,
      ConfigProvider.fromEnv({ env: { ...env, JOB_MODEL_BUDGET_USD_MAX: "0.5" } }),
    ),
  ).toThrow(
    "JOB_MODEL_BUDGET_USD_DEFAULT: Expected a value less than or equal to JOB_MODEL_BUDGET_USD_MAX (0.5), got 1",
  );
});
