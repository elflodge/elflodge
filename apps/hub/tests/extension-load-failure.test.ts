import path from "node:path";

import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import { startSystem, submitJob } from "./harness.ts";

// A job whose extension does not load fails, naming it, rather than run without it.

const system = startSystem();

beforeAll(async () => {
  await system.start();
  await system.startRunner({
    extensions: [path.join(import.meta.dirname, "fixtures", "broken-extension")],
  });
});
afterAll(() => system.stop());

test("a job whose extension fails to load fails, naming the extension", async () => {
  const client = await system.clientWithNewJobsKey();
  const { id } = await submitJob(client, {
    input: "Summarise the quarter.",
    outputContract: { schema: { type: "object" } },
  });
  await expect
    .poll(async () => (await client.jobs.get({ id })).status, { timeout: 10_000 })
    .toMatch(/^(succeeded|failed)$/);
  expect(await client.jobs.get({ id })).toMatchObject({
    status: "failed",
    failure: {
      reason: "runFaulted",
      message: expect.stringMatching(
        /broken-extension.*This extension needs a setting it does not have\./,
      ),
    },
  });
});
