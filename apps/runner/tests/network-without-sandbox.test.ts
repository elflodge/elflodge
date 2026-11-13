import { Effect, Exit } from "effect";
import { expect, it, vi } from "vite-plus/test";

import type { NetworkSettings } from "../src/network.ts";

// Only the sandbox holds jobs' commands to a network setting, so a Runner allowed to run jobs
// without one must refuse to start with either setting rather than ignore it. Each case imports the
// Runner afresh, as jobs' network is set once per process, with sandbox-runtime reporting no
// sandbox on this platform.
async function startWithoutSandbox(network: NetworkSettings) {
  vi.resetModules();
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
  vi.spyOn(SandboxManager, "isSupportedPlatform").mockReturnValue(false);
  const { DEFAULT_SANDBOX_SETTINGS } = await import("../src/index.ts");
  const { prepareJobEnvironments } = await import("../src/sandbox.ts");
  return Effect.runPromiseExit(
    prepareJobEnvironments({ ...DEFAULT_SANDBOX_SETTINGS, runWithoutSandbox: true }, network),
  );
}

it("a Runner allowed to run jobs without a sandbox refuses to start with a network setting", async () => {
  for (const network of [
    { mode: "none", exceptions: [] },
    { mode: "open", exceptions: [{ range: "10.0.0.0/8" }] },
  ] satisfies NetworkSettings[]) {
    const started = await startWithoutSandbox(network);
    expect(Exit.isFailure(started), JSON.stringify(network)).toBe(true);
    expect(JSON.stringify(started), JSON.stringify(network)).toContain("cannot apply");
  }
  // With the default network, it starts.
  expect(Exit.isSuccess(await startWithoutSandbox({ mode: "open", exceptions: [] }))).toBe(true);
});
