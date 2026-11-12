import { beforeAll, expect, it } from "vite-plus/test";

import type { JobEnvironments } from "../src/sandbox.ts";
import {
  HOST_SERVER_ANSWER,
  prepareTestEnvironments,
  run,
  withHostServer,
  withJob,
} from "./jobs.ts";

// RUNNER_NETWORK=none gives jobs' commands no network at all (ADR 0041).

let environments: JobEnvironments;
beforeAll(async () => {
  environments = await prepareTestEnvironments({ mode: "none", exceptions: [] });
});

it("with the network off, a job's commands reach nothing, and are told why", () =>
  withHostServer("127.0.0.1", (port) =>
    withJob(environments, async (job) => {
      // A public address, refused by the proxy before it dials, so no internet is needed.
      const publicAddress = await run(job, "curl -sS --max-time 5 http://1.1.1.1/");
      expect(publicAddress.output).toContain("no network access (RUNNER_NETWORK=none)");
      for (const tunnel of ["", "--proxytunnel"]) {
        const host = await run(
          job,
          `curl -sS --max-time 5 --noproxy '' ${tunnel} --proxy "$HTTPS_PROXY" http://127.0.0.1:${port}/`,
        );
        expect(host.output).not.toContain(HOST_SERVER_ANSWER);
      }
    }),
  ));
