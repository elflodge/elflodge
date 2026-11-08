import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { it } from "@effect/vitest";
import { Clock, Effect } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";

import { makePromptCacheWarmup } from "../src/prompt-cache.ts";

// The warm-up's timing, on Effect's test clock. Which jobs wait for which, and what releases
// them, is tested through the hub in warm-up.test.ts.

const PROMPT = {
  instructions: "Extract a count.",
  outputContract: { schema: { type: "integer" } },
};

/** Jobs sharing a prompt, whose agents start and respond as the test says. */
const fixture = Effect.gen(function* () {
  const warmup = yield* makePromptCacheWarmup;
  const started: string[] = [];
  const responders = new Map<string, (requestStartedAt: number) => void>();
  const launch = (name: string) =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        warmup.run(PROMPT, ({ ready, modelResponded }) =>
          ready.pipe(
            Effect.andThen(
              Effect.sync(() => {
                started.push(name);
                responders.set(name, (timestamp) =>
                  modelResponded({ ...fauxAssistantMessage("Counted."), timestamp }),
                );
              }),
            ),
            Effect.andThen(Effect.never),
          ),
        ),
      );
      yield* TestClock.adjust(0);
    });
  /** Ends a successful call of `name`'s model whose request started `ago` before now. */
  const respond = (name: string, ago = 0) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      responders.get(name)?.(now - ago);
      yield* TestClock.adjust(0);
    });
  return { launch, respond, started };
});

it.effect("a first call that has not returned holds the others for ten seconds", () =>
  Effect.gen(function* () {
    const jobs = yield* fixture;
    yield* jobs.launch("first");
    yield* TestClock.adjust("4 seconds");
    yield* jobs.launch("second");
    yield* TestClock.adjust("5 seconds");
    expect(jobs.started).toEqual(["first"]);
    yield* TestClock.adjust("1 second");
    expect(jobs.started).toEqual(["first", "second"]);
  }),
);

it.effect(
  "a prompt stays warm for five minutes from the start of its latest successful request",
  () =>
    Effect.gen(function* () {
      const jobs = yield* fixture;
      yield* jobs.launch("first");
      // The first call took a minute, so its prompt is cached for four more.
      yield* jobs.respond("first", 60_000);
      yield* TestClock.adjust("239 seconds");
      yield* jobs.launch("warm");
      expect(jobs.started).toEqual(["first", "warm"]);
      yield* TestClock.adjust("1 second");
      yield* jobs.launch("warms again");
      yield* jobs.launch("waits");
      expect(jobs.started).toEqual(["first", "warm", "warms again"]);
      yield* jobs.respond("warms again");
      expect(jobs.started.at(-1)).toBe("waits");
      yield* TestClock.adjust("299 seconds");
      yield* jobs.launch("still warm");
      expect(jobs.started.at(-1)).toBe("still warm");
    }),
);
