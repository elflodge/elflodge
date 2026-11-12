import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { Effect } from "effect";

import { DEFAULT_SANDBOX_SETTINGS } from "../src/index.ts";
import type { NetworkSettings } from "../src/network.ts";
import {
  type JobEnvironment,
  type JobEnvironments,
  prepareJobEnvironments,
} from "../src/sandbox.ts";

// What the sandbox tests share. sandbox-runtime's network policy is the process's, set by its first
// sandbox, so each network setting is tested in a file of its own.

/** The Runner's job environments under `network`, with a memory limit low enough to reach. */
export function prepareTestEnvironments(network: NetworkSettings) {
  return Effect.runPromise(
    prepareJobEnvironments({ ...DEFAULT_SANDBOX_SETTINGS, jobMemoryLimit: "256M" }, network),
  );
}

/** Runs `use` with a job's environment in a new job directory, closed and removed afterwards. */
export async function withJob(
  environments: JobEnvironments,
  use: (
    job: JobEnvironment,
    dirs: { dir: string; workspace: string; temp: string },
  ) => Promise<void>,
) {
  const dir = await mkdtemp(path.join(await realpath(tmpdir()), "job-"));
  const dirs = { dir, workspace: path.join(dir, "workspace"), temp: path.join(dir, "tmp") };
  await mkdir(dirs.workspace);
  const job = environments.open(path.basename(dir), dirs);
  try {
    await use(job, dirs);
  } finally {
    await job.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Runs `command` in the job's shell and returns its exit code and its output, both streams together. */
export async function run(job: JobEnvironment, command: string) {
  let output = "";
  const result = await job.env.exec(
    command,
    { onOutput: (text) => (output += text) },
    BACKGROUND_CONTEXT,
  );
  return { exitCode: getOrThrow(result).exitCode, output };
}

/** What the server `withHostServer` starts answers. */
export const HOST_SERVER_ANSWER = "answered by the Runner's host";

/** Runs `use` with an HTTP server on the Runner's host at `host`, which answers `HOST_SERVER_ANSWER`. */
export async function withHostServer(host: string, use: (port: number) => Promise<void>) {
  const server = createServer((_request, response) => response.end(HOST_SERVER_ANSWER));
  server.on("error", () => {});
  server.on("connection", (socket) => socket.on("error", () => {}));
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    await use(address.port);
  } finally {
    server.close();
  }
}
