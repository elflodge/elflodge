import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { createEnvConformance, createExpectAssertions } from "@earendil-works/pi-durable/testing";
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { DEFAULT_NETWORK_SETTINGS } from "../src/index.ts";
import type { JobEnvironment, JobEnvironments } from "../src/sandbox.ts";
import {
  HOST_SERVER_ANSWER,
  prepareTestEnvironments,
  run,
  throughProxy,
  withHostServer,
  withJob as withJobIn,
} from "./job-environments.ts";

// pi-durable's tools reach a job's files and commands only through this environment: pi-env's
// daemon in the job's sandbox (ADR 0027). So it is held to the cases pi-durable defines for every
// environment, and to what the sandbox promises a job: its own folders and the system's programs,
// the default network (ADR 0041), none of the Runner's variables, no other processes, a memory
// limit where systemd can set one, and on Linux processes the kernel kills before the Runner when
// the host runs out of memory.

const execFileAsync = promisify(execFile);

/** pgrep's and pkill's exit status 1: no process matched, or (pkill) none could be signalled. */
function noneMatched(error: { code?: unknown }) {
  if (error.code === 1) return false;
  throw error;
}

let environments: JobEnvironments;
beforeAll(async () => {
  environments = await prepareTestEnvironments(DEFAULT_NETWORK_SETTINGS);
});

const withJob = (use: Parameters<typeof withJobIn>[1]) => withJobIn(environments, use);

/**
 * Leaves a `sleep` running in the job's background, for a random duration, and returns whether it
 * is still running, as seen from outside the sandbox.
 */
async function leaveSleepRunning(job: JobEnvironment) {
  const seconds = String(1000 + Math.floor(Math.random() * 9000));
  await run(job, `nohup sleep ${seconds} >/dev/null 2>&1 &`);
  // The whole command line, matched exactly; the random duration makes another match unlikely.
  const args = ["-x", "-f", `sleep ${seconds}`];
  const sleeping = () => execFileAsync("pgrep", args).then(() => true, noneMatched);
  // Where closing the job leaves it running (macOS), so it does not outlive the test.
  onTestFinished(async () => {
    await execFileAsync("pkill", args).catch(noneMatched);
  });
  // Polled: while the background shell execs `nohup` and then `sleep`, its command line is briefly empty.
  await expect.poll(sleeping).toBe(true);
  return { seconds, sleeping };
}

const onMacOS = process.platform === "darwin";

// Under Seatbelt these cases see no change reported, though the same cases pass under bubblewrap.
const failingOnMacOS = new Set([
  "watch reports a missing file's creation, changes, replacement and removal",
  "watch follows directories created together with their contents",
  "watch keeps watching a path whose parent is renamed and recreated",
  "watch follows a directory replaced at the same path",
]);

describe("pi-durable's environment cases", () => {
  const cases = createEnvConformance({
    assertions: createExpectAssertions(expect),
    withEnv: (use) => withJob((job) => use(job.env)),
  });
  for (const testCase of cases) {
    const fails = onMacOS && failingOnMacOS.has(testCase.name);
    it(testCase.name, { timeout: testCase.timeoutMs, fails }, () => testCase.run());
  }
});

// pi-durable's cases leave out the byte-order mark, which files saved by Windows tools, such as
// Excel's CSVs, begin with: an agent's edit must keep it.
it("a file's text keeps its byte-order mark, which pi-durable's edit tool writes back", () =>
  withJob(async (job, { workspace }) => {
    await writeFile(path.join(workspace, "q3.csv"), "﻿quarter,revenue\r\n");
    const text = await job.env.readTextFile("q3.csv", BACKGROUND_CONTEXT);
    expect(text).toEqual({
      ok: true,
      value: await readFile(path.join(workspace, "q3.csv"), "utf8"),
    });
  }));

it("a job reads and writes its own folders, and nothing of another job, its journal or the operator's home", () =>
  withJob(async (job, { dir, workspace }) => {
    const other = await mkdtemp(path.join(tmpdir(), "other-job-"));
    try {
      const journal = path.join(dir, "journal.sqlite");
      await writeFile(path.join(other, "file.txt"), "another job's file");
      await writeFile(journal, "the job's journal");
      await symlink(path.join(other, "file.txt"), path.join(workspace, "link-out"));

      expect((await run(job, "echo made > made.txt && cat made.txt")).output).toBe("made\n");
      for (const outside of [
        path.join(other, "file.txt"),
        path.join(workspace, "link-out"),
        journal,
        path.join(homedir(), ".bashrc"),
      ]) {
        expect((await job.env.readTextFile(outside, BACKGROUND_CONTEXT)).ok).toBe(false);
        expect((await run(job, `cat '${outside}'`)).exitCode).not.toBe(0);
      }
      // Outside its own folders a job sees only empty folders private to its sandbox, so what it
      // writes there never reaches the host.
      await job.env.writeFile(path.join(other, "x"), "x", BACKGROUND_CONTEXT);
      await run(job, `echo x > '${path.join(other, "y")}'`);
      expect(await readdir(other)).toEqual(["file.txt"]);
      await job.env.writeFile(journal, "x", BACKGROUND_CONTEXT);
      await run(job, `echo x > '${journal}'`);
      expect(await readFile(journal, "utf8")).toBe("the job's journal");
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  }));

// A job reaches the network through sandbox-runtime's proxies, its HTTP proxy named in `HTTPS_PROXY`
// and `ALL_PROXY` and its SOCKS proxy in `FTP_PROXY`, which refuse the Runner's host and local and
// private addresses. `NO_PROXY` sends `localhost` and `127.0.0.1` past them, into the sandbox's own
// network, so these requests name the proxy themselves.

it("a job's commands cannot reach the Runner's host by its loopback, however it is spelled", () =>
  withHostServer("127.0.0.1", (port) =>
    withJob(async (job) => {
      const direct = await run(job, `bash -c 'exec 3<>/dev/tcp/127.0.0.1/${port}'`);
      expect(direct.exitCode).not.toBe(0);
      for (const host of [
        "127.0.0.1",
        "127.1",
        "2130706433",
        "[::ffff:127.0.0.1]",
        "localhost",
        "job.localhost",
      ]) {
        for (const answer of await throughProxy(job, host, port)) {
          expect(answer, host).not.toContain(HOST_SERVER_ANSWER);
          expect(answer, host).toMatch(/status=403|connect=403/);
        }
      }
      const socks = await run(
        job,
        `curl -sS --max-time 5 --noproxy '' --proxy "$FTP_PROXY" http://127.0.0.1:${port}/`,
      );
      expect(socks.output).not.toContain(HOST_SERVER_ANSWER);
      // Refused by the SOCKS proxy, rather than missing it.
      expect(socks.output).toMatch(/SOCKS5.*\(2\)/);
    }),
  ));

it("a refused request tells the agent what is refused and which setting opens it", () =>
  withJob(async (job) => {
    // Refused before the proxy dials, so no such network is needed.
    const plain = await run(job, "curl -sS --max-time 5 http://10.255.255.1/");
    expect(plain.output).toContain("Private network addresses are blocked");
    expect(plain.output).toContain("RUNNER_NETWORK_EXCEPTIONS");
    const tunnel = await run(job, "curl -sS -v --max-time 5 https://10.255.255.1/ 2>&1");
    expect(tunnel.output).toMatch(
      /403 Private network addresses are blocked.*RUNNER_NETWORK_EXCEPTIONS/,
    );
  }));

it("a server one of a job's commands starts is reached at localhost by its later commands", async (test) => {
  // On macOS, Seatbelt refuses jobs' commands loopback.
  if (process.platform !== "linux") test.skip("only Linux gives a job's commands a loopback");
  await withJob(async (job) => {
    await run(job, "nohup python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 &");
    await expect
      .poll(
        async () =>
          (
            await run(
              job,
              "curl -sS --max-time 5 -o /dev/null -w '%{http_code}' http://localhost:8765/",
            )
          ).output,
        // Python takes its time starting on a loaded machine.
        { timeout: 10_000 },
      )
      .toBe("200");
  });
}, 20_000);

it("a job's processes see none of the Runner's variables, nor its processes or another job's", async () => {
  vi.stubEnv("ELFLODGE_TEST_RUNNER_VARIABLE", "runner-only");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  await withJob(async (job) => {
    expect((await run(job, "env")).output).not.toContain("runner-only");
    expect((await run(job, `kill -0 ${process.pid}`)).exitCode).not.toBe(0);
    expect((await run(job, "ps -e -o comm=")).output).not.toMatch(/\bnode\b/);
    await withJob(async (other) => {
      const { seconds } = await leaveSleepRunning(other);
      expect((await run(job, "ps -e -o args=")).output).not.toContain(`sleep ${seconds}`);
    });
  });
});

it("a job's temporary files go to its temp directory", () =>
  withJob(async (job, { temp }) => {
    expect((await run(job, 'echo "$TMPDIR"')).output).toBe(`${temp}\n`);
    expect((await run(job, 'echo job > "$TMPDIR/file"')).exitCode).toBe(0);
    expect(await readFile(path.join(temp, "file"), "utf8")).toBe("job\n");
  }));

it("aborting or timing out a command stops it without touching another job's", () =>
  withJob((other, { workspace: othersWorkspace }) =>
    withJob(async (job) => {
      // Runs until the test, having stopped this job's commands, lets it end.
      const othersCommand = run(
        other,
        "until [ -e done ]; do sleep 0.05; done; echo still running",
      );

      const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
      let started = Date.now();
      const aborted = job.env.exec("sleep 30", undefined, context);
      setTimeout(() => cancel(), 200);
      const abortedResult = await aborted;
      expect(abortedResult.ok ? undefined : abortedResult.error.code).toBe("aborted");
      expect(Date.now() - started).toBeLessThan(5_000);

      started = Date.now();
      const timedOut = await job.env.exec("sleep 30", { timeout: 0.2 }, BACKGROUND_CONTEXT);
      expect(timedOut.ok ? undefined : timedOut.error.code).toBe("timeout");
      expect(Date.now() - started).toBeLessThan(5_000);

      await writeFile(path.join(othersWorkspace, "done"), "");
      expect((await othersCommand).output).toBe("still running\n");
    }),
  ));

// Under Seatbelt the background process is still running after the job closes.
it("closing a job stops what it left running", { fails: onMacOS }, () =>
  withJob(async (job) => {
    const { sleeping } = await leaveSleepRunning(job);
    await job.close();
    await expect.poll(sleeping).toBe(false);
  }),
);

it("a job's processes are the kernel's choice over the Runner when the host runs out of memory", async (test) => {
  if (process.platform !== "linux") test.skip(`${process.platform} has no OOM scores`);
  await withJob(async (job) => {
    const { output } = await run(job, "cat /proc/self/oom_score_adj");
    const runners = Number(await readFile("/proc/self/oom_score_adj", "utf8"));
    expect(Number(output)).toBeGreaterThan(runners);
  });
});

it("a command that goes over the job's memory limit is stopped and the agent told, and the job carries on", async (test) => {
  if (environments.uncappedBecause) test.skip(environments.uncappedBecause);
  await withJob(async (job) => {
    const over = await run(job, "python3 -c 'b = bytearray(1 << 30); print(len(b))'");
    expect(over.exitCode).not.toBe(0);
    expect(over.output).toContain("went over their 256M of memory");
    // The kill count can still rise after the command over the limit has returned, as it has on
    // CI, and every command that ends while it rises is told, so this one may be too.
    const next = await run(job, "echo still here");
    expect(next.exitCode).toBe(0);
    expect(next.output).toMatch(/^still here\n/);
  });
});
