import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Layer, Option, Stdio } from "effect";
import { CliError } from "effect/cli";
import { describe, expect, onTestFinished, vi } from "vite-plus/test";

import { runnerCli } from "../src/main.ts";

// `elflodge stack` and the Runner image call the Runner with these exact arguments. With no
// settings, a list the command line accepts stops at reading them, and one it refuses never gets
// there.

/** Runs the Runner's command line in-process on `args` with no settings, and what it printed on stderr. */
function runner(args: string[]) {
  return Effect.gen(function* () {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    // Help goes to stdout; parse errors go to stderr.
    vi.spyOn(console, "log").mockImplementation(() => {});
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const exit = yield* runnerCli.pipe(
      Effect.provide(
        Layer.mergeAll(
          Stdio.layerTest({ args: Effect.succeed(args) }),
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
        ),
      ),
      Effect.exit,
    );
    return { exit, stderr: stderr.mock.calls.flat().join("\n") };
  });
}

describe("the Runner's command line", () => {
  it.live.each([
    { args: ["--healthcheck"] },
    { args: ["register"] },
    { args: ["register", "--healthcheck"] },
    { args: ["login"] },
    { args: ["login", "--with-api-key"] },
    { args: ["logout"] },
    { args: ["auth-check"] },
    { args: ["auth-check", "--login"] },
    { args: ["auth-status"] },
  ])("accepts $args", ({ args }) =>
    Effect.gen(function* () {
      const { exit, stderr } = yield* runner(args);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(stderr).toContain("The Runner is not configured");
    }),
  );

  it.live.each([
    { args: ["login", "--healthcheck"] },
    { args: ["logout", "--with-api-key"] },
    { args: ["auth-check", "--with-api-key"] },
    { args: ["unknown"] },
  ])("refuses $args", ({ args }) =>
    Effect.gen(function* () {
      const { exit, stderr } = yield* runner(args);

      expect(CliError.isCliError(Option.getOrUndefined(Exit.findErrorOption(exit)))).toBe(true);
      expect(stderr).not.toContain("The Runner is not configured");
    }),
  );

  // The one start of the entry point itself, with no arguments, as the image starts it: its
  // refusal reaches the shell as a failing exit code.
  it("accepts [] from a started process, and exits 1", async () => {
    const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    await expect(
      promisify(execFile)(
        process.execPath,
        // The workspace's packages resolve to their source, as in the Runner's other tests.
        ["--conditions=@elflodge/source", main],
        { env: { PATH: process.env.PATH } },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("The Runner is not configured"),
    });
  });

  it("says what to do when the hub refuses its registration key, and exits 1", async ({
    signal,
  }) => {
    await using hub = createServer((_request, response) => {
      response.writeHead(401, { "content-type": "application/problem+json" });
      response.end(JSON.stringify({ type: "about:blank", title: "Unauthorized", status: 401 }));
    });
    const onServerError = vi.fn();
    hub.on("error", onServerError);
    onTestFinished(() => {
      expect(onServerError).not.toHaveBeenCalled();
    });
    hub.listen(0, "127.0.0.1");
    await once(hub, "listening");
    const address = hub.address();
    if (address === null || typeof address === "string") throw new Error("Not listening on TCP");
    const { port } = address;
    const dataDir = await mkdtemp(path.join(tmpdir(), "runner-"));
    onTestFinished(() => rm(dataDir, { recursive: true, force: true }));
    const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    await expect(
      promisify(execFile)(process.execPath, ["--conditions=@elflodge/source", main], {
        // A Runner that retried rather than refusing would never exit.
        signal,
        env: {
          PATH: process.env.PATH,
          HUB_URL: `http://127.0.0.1:${port}`,
          RUNNER_REGISTRATION_KEY: "an expired key",
          RUNNER_MODEL_PROVIDER: "anthropic",
          RUNNER_MODEL_ID: "claude-sonnet-4-5",
          ANTHROPIC_API_KEY: "not used",
          RUNNER_DATA_DIR: dataDir,
          RUNNER_RUN_WITHOUT_SANDBOX: "true",
        },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(
        /The hub refused RUNNER_REGISTRATION_KEY.*new registration key/s,
      ),
    });
  });
});
