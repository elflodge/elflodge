import path from "node:path";

import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import { startSystem, submitJob } from "./harness.ts";
import { callTool, lastToolResult } from "./scripted-model.ts";

// A Runner that loads Pi extensions: each job's agent can call their tools, which run commands in
// the job's sandbox and Workspace, as its own tools do.

const system = startSystem();

beforeAll(async () => {
  await system.start();
  await system.startRunner({
    extensions: { extensions: path.join(import.meta.dirname, "fixtures", "extensions") },
  });
});
afterAll(() => system.stop());

test("a job's agent calls an extension's tool, whose command runs in the job's Workspace", async () => {
  system.model.setResponses([
    callTool("show_file", { path: "inputs/q3.md" }),
    (context) =>
      callTool("submit_output", { value: { summary: lastToolResult(context.messages).text } }),
  ]);
  const client = await system.clientWithNewJobsKey();
  const { id } = await submitJob(client, {
    input: "Summarise the quarter.",
    files: [{ path: "q3.md", content: "Revenue grew 4%." }],
    outputContract: {
      schema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
    },
  });
  await expect
    .poll(async () => (await client.jobs.get({ id })).status, { timeout: 10_000 })
    .toMatch(/^(succeeded|failed)$/);
  expect(await client.jobs.get({ id })).toMatchObject({
    status: "succeeded",
    output: { summary: "Revenue grew 4%." },
  });
});
