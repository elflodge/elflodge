import { beforeAll, expect, it } from "vite-plus/test";

import type { JobEnvironments } from "../src/sandbox.ts";
import {
  HOST_SERVER_ANSWER,
  prepareTestEnvironments,
  run,
  withHostServer,
  withJob,
} from "./job-environments.ts";

// An operator opens local and private ranges with RUNNER_NETWORK_EXCEPTIONS (ADR 0041). A range
// opens every address it covers, the Runner's own included, such as its loopback address here, which
// the default refuses (`sandbox.test.ts`).

let environments: JobEnvironments;
beforeAll(async () => {
  environments = await prepareTestEnvironments({ mode: "open", exceptions: ["127.0.0.0/30"] });
});

it("an exception range opens the servers in it to jobs' commands, on the Runner's own address too", async (test) => {
  if (process.platform !== "linux") test.skip("only Linux routes all of 127.0.0.0/8 to loopback");
  await withHostServer("127.0.0.2", (port) =>
    withJob(environments, async (job) => {
      const reached = await run(job, `curl -sS --max-time 5 http://127.0.0.2:${port}/`);
      expect(reached.output).toBe(HOST_SERVER_ANSWER);
    }),
  );
  // `NO_PROXY` keeps 127.0.0.1 on the job's own loopback, so the Runner's is reached through the
  // proxy only by a request that names it.
  await withHostServer("127.0.0.1", (port) =>
    withJob(environments, async (job) => {
      const reached = await run(
        job,
        `curl -sS --max-time 5 --noproxy '' --proxy "$HTTPS_PROXY" http://127.0.0.1:${port}/`,
      );
      expect(reached.output).toBe(HOST_SERVER_ANSWER);
    }),
  );
});
