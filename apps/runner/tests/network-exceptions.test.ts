import { Effect, Exit } from "effect";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";

import { parseException } from "../src/network.ts";
import type { JobEnvironments } from "../src/sandbox.ts";
import {
  HOST_SERVER_ANSWER,
  prepareTestEnvironments,
  run,
  startHostServer,
  throughProxy,
  withHostServer,
  withJob,
} from "./job-environments.ts";

// An operator opens local and private ranges with RUNNER_NETWORK_EXCEPTIONS (ADR 0041). A range
// opens every address it covers, the Runner's own included, such as its loopback addresses here,
// which the default refuses (`sandbox.test.ts`), on every port or on the one it names.

let environments: JobEnvironments;
// A server on the Runner's loopback address, whose port alone the exception for it opens.
let opened: Awaited<ReturnType<typeof startHostServer>>;
beforeAll(async () => {
  opened = await startHostServer("127.0.0.1");
  environments = await prepareTestEnvironments({
    mode: "open",
    exceptions: [{ range: "127.0.0.2/31" }, { range: "127.0.0.1/32", port: opened.port }],
  });
});
afterAll(() => opened.close());

it("an exception range opens the servers in it to jobs' commands, on the Runner's own address too", async (test) => {
  if (process.platform !== "linux") test.skip("only Linux routes all of 127.0.0.0/8 to loopback");
  await withHostServer("127.0.0.3", (port) =>
    withJob(environments, async (job) => {
      const reached = await run(job, `curl -sS --max-time 5 http://127.0.0.3:${port}/`);
      expect(reached.output).toBe(HOST_SERVER_ANSWER);
    }),
  );
});

it("an exception on a port opens that port alone, however the address and its other ports are named", () =>
  // `NO_PROXY` keeps 127.0.0.1 on the job's own loopback, so the Runner's is reached through the
  // proxy only by a request that names it.
  withHostServer("127.0.0.1", (otherPort) =>
    withJob(environments, async (job) => {
      for (const answer of await throughProxy(job, "127.0.0.1", opened.port)) {
        expect(answer).toContain(HOST_SERVER_ANSWER);
      }
      for (const host of ["127.0.0.1", "[::ffff:127.0.0.1]", "job.localhost"]) {
        for (const answer of await throughProxy(job, host, otherPort)) {
          expect(answer, host).not.toContain(HOST_SERVER_ANSWER);
          expect(answer, host).toMatch(/status=403|connect=403/);
        }
      }
      // curl rewrites some of these hosts before it asks, such as 2130706433 to 127.0.0.1, and
      // refuses others; a client that asks as written is refused too, or finds no such name (502).
      for (const [host, status] of [
        ["2130706433", 403],
        ["127.0.0.1..", 502],
        ["localhost.", 403],
        ["localhost..", 403],
        ["job.localhost.", 403],
        ["job.localhost..", 403],
      ] as const) {
        const asWritten = await run(
          job,
          `bash <<'EOF'
          p=\${HTTPS_PROXY#http://}; auth=$(printf %s "\${p%@*}" | base64 | tr -d '\\n')
          proxy=\${p#*@}; proxy=\${proxy%/}; exec 3<>/dev/tcp/\${proxy%:*}/\${proxy##*:}
          printf 'CONNECT ${host}:${otherPort} HTTP/1.1\\r\\nProxy-Authorization: Basic %s\\r\\n\\r\\n' "$auth" >&3
          head -1 <&3
EOF`,
        );
        expect(asWritten.output, host).toMatch(`HTTP/1.1 ${status} `);
      }
      const socks = await run(
        job,
        `curl -sS --max-time 5 --noproxy '' --proxy "$FTP_PROXY" http://127.0.0.1:${otherPort}/`,
      );
      expect(socks.output).not.toContain(HOST_SERVER_ANSWER);
      expect(socks.output).toMatch(/SOCKS5.*\(2\)/);
    }),
  ));

const read = (entry: string) => Effect.runSyncExit(parseException(entry));

it("an exception names its port as sandbox-runtime names a destination's, and no other", () => {
  expect(read("10.0.0.0/8:8080")).toEqual(Exit.succeed({ range: "10.0.0.0/8", port: 8080 }));
  expect(read("[fd00::5]:8080")).toEqual(Exit.succeed({ range: "fd00::5/128", port: 8080 }));
  // Unbracketed, the last group is the address's.
  expect(read("fd00::5:8080")).toEqual(Exit.succeed({ range: "fd00::5:8080/128" }));
  for (const entry of ["10.0.0.5:0", "10.0.0.5:65536", "10.0.0.5:", "[fd00::5", "[fd00::5]x"])
    expect(Exit.isFailure(read(entry)), entry).toBe(true);
});
