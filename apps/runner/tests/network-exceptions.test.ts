import { beforeAll, expect, it } from "vite-plus/test";

import type { JobEnvironments } from "../src/sandbox.ts";
import {
  HOST_SERVER_ANSWER,
  prepareTestEnvironments,
  run,
  withHostServer,
  withJob,
} from "./jobs.ts";

// An operator opens local and private ranges with RUNNER_NETWORK_EXCEPTIONS (ADR 0041). The Runner's
// own addresses stay refused, so the server here listens on another loopback address, which Linux
// routes to the loopback interface unasked.

let environments: JobEnvironments;
beforeAll(async () => {
  environments = await prepareTestEnvironments({ mode: "open", exceptions: ["127.0.0.2/32"] });
});

it("an exception range opens a server in it to jobs' commands", async (test) => {
  if (process.platform !== "linux") test.skip("only Linux routes all of 127.0.0.0/8 to loopback");
  await withHostServer("127.0.0.2", (port) =>
    withJob(environments, async (job) => {
      const reached = await run(job, `curl -sS --max-time 5 http://127.0.0.2:${port}/`);
      expect(reached.output).toBe(HOST_SERVER_ANSWER);
    }),
  );
});
