import path from "node:path";

import { afterAll, beforeAll, expect, test, vi } from "vite-plus/test";

import { startSystem, submitJob } from "./harness.ts";
import { callTool, lastToolResult } from "./scripted-model.ts";

// pi-web-access, which the Runner's image ships, runs in the Runner's process, outside every job's
// sandbox, and the Runner holds it to jobs' network by routing it through the proxy that holds jobs'
// commands. The Runner installs the image's set of extensions from the registry, as it does when it
// starts.

/** A documentation address, which pi-web-access's own guard lets through and jobs' proxy refuses. */
const REFUSED = "192.0.2.1";

const system = startSystem();

beforeAll(async () => {
  // pi-web-access sends a host `NO_PROXY` names past any proxy, so the Runner's must not reach it.
  vi.stubEnv("NO_PROXY", REFUSED);
  await system.start();
  await system.startRunner({
    extensions: { extensions: path.join(import.meta.dirname, "../../runner/extensions") },
  });
}, 300_000);
afterAll(async () => {
  await system.stop();
  vi.unstubAllEnvs();
});

// A fetch that took any route around the proxy would fail to connect instead of being refused.
test("fetch_content is refused what jobs' commands are refused", async () => {
  system.model.setResponses([
    callTool("fetch_content", { url: `http://${REFUSED}/`, mode: "raw" }),
    (context) =>
      callTool("submit_output", { value: { fetched: lastToolResult(context.messages).text } }),
  ]);
  const client = await system.clientWithNewJobsKey();
  const { id } = await submitJob(client, {
    input: "Fetch the page.",
    outputContract: {
      schema: {
        type: "object",
        properties: { fetched: { type: "string" } },
        required: ["fetched"],
      },
    },
  });
  await expect
    .poll(async () => (await client.jobs.get({ id })).status, { timeout: 60_000 })
    .toMatch(/^(succeeded|failed)$/);
  expect(await client.jobs.get({ id })).toMatchObject({
    status: "succeeded",
    output: { fetched: expect.stringContaining("Documentation addresses are blocked for jobs") },
  });
}, 90_000);
