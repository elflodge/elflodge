import { it } from "@effect/vitest";
import type { JobContent } from "contract";
import { Effect, Fiber, Latch } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";

import { makePromptCacheWarmup } from "../src/prompt-cache.ts";

const OPENING = {
  instructions: "Extract a count.",
  outputContract: { schema: { type: "integer" } },
};

/** Agents whose calls and ends the test controls, behind the same startup gate as real jobs. */
const fixture = Effect.gen(function* () {
  const cache = yield* makePromptCacheWarmup;
  const started: string[] = [];
  const calls = new Map<string, (succeeded: boolean) => void>();
  const ends = new Map<string, Latch.Latch>();
  const launch = (
    name: string,
    opening: Pick<JobContent, "instructions" | "outputContract"> = OPENING,
  ) =>
    Effect.gen(function* () {
      const end = Latch.makeUnsafe(false);
      ends.set(name, end);
      const fiber = yield* Effect.forkScoped(
        cache.run(opening, ({ ready, modelCallCompleted, agentStarted }) =>
          ready.pipe(
            Effect.andThen(
              Effect.sync(() => {
                started.push(name);
                calls.set(name, modelCallCompleted);
                agentStarted();
              }),
            ),
            Effect.andThen(end.await),
          ),
        ),
      );
      yield* TestClock.adjust(0);
      return fiber;
    });
  const complete = (name: string, succeeded = true) => {
    const completed = calls.get(name);
    if (!completed) throw new Error(`The agent ${name} has not started`);
    completed(succeeded);
  };
  return { launch, complete, started, end: (name: string) => ends.get(name)?.openUnsafe() };
});

it.effect.each(["response", "failure", "end", "cap"] as const)(
  "%s releases the waiting agents once, even if the first call arrives again or late",
  (release) =>
    Effect.gen(function* () {
      const jobs = yield* fixture;
      yield* jobs.launch("first");
      yield* jobs.launch("second");
      yield* jobs.launch("third");
      expect(jobs.started).toEqual(["first"]);
      if (release === "response") jobs.complete("first");
      if (release === "failure") jobs.complete("first", false);
      if (release === "end") jobs.end("first");
      if (release === "cap") {
        yield* TestClock.adjust("9 seconds");
        expect(jobs.started).toEqual(["first"]);
        yield* TestClock.adjust("1 second");
      }
      yield* TestClock.adjust(0);
      expect(jobs.started).toEqual(["first", "second", "third"]);
      jobs.complete("first");
      jobs.complete("first");
      yield* TestClock.adjust("10 seconds");
      expect(jobs.started).toEqual(["first", "second", "third"]);
    }),
);

it.effect("a failed first call leaves the prefix cold for the next job", () =>
  Effect.gen(function* () {
    const jobs = yield* fixture;
    yield* jobs.launch("first");
    jobs.complete("first", false);
    yield* jobs.launch("new first");
    yield* jobs.launch("waiting");
    expect(jobs.started).toEqual(["first", "new first"]);
  }),
);

it.effect(
  "warmth lasts five minutes from the latest completed call, not the latest job start",
  () =>
    Effect.gen(function* () {
      const jobs = yield* fixture;
      yield* jobs.launch("first");
      jobs.complete("first");
      yield* TestClock.adjust("4 minutes");
      yield* jobs.launch("second");
      expect(jobs.started).toEqual(["first", "second"]);
      jobs.complete("second");
      yield* TestClock.adjust("299 seconds");
      yield* jobs.launch("third");
      expect(jobs.started).toEqual(["first", "second", "third"]);
      yield* TestClock.adjust("1 second");
      yield* jobs.launch("new first");
      yield* jobs.launch("waiting");
      expect(jobs.started).toEqual(["first", "second", "third", "new first"]);
      jobs.complete("new first");
      yield* TestClock.adjust(0);
      expect(jobs.started.at(-1)).toBe("waiting");
    }),
);

it.effect("different instructions or Output contracts warm independently", () =>
  Effect.gen(function* () {
    const jobs = yield* fixture;
    yield* jobs.launch("first");
    yield* jobs.launch("same opening", { ...OPENING });
    yield* jobs.launch("other instructions", { ...OPENING, instructions: "Extract a total." });
    yield* jobs.launch("other contract", {
      ...OPENING,
      outputContract: { schema: { type: "string" } },
    });
    expect(jobs.started).toEqual(["first", "other instructions", "other contract"]);
    jobs.complete("first");
    yield* TestClock.adjust(0);
    expect(jobs.started.at(-1)).toBe("same opening");
  }),
);

it.effect("interrupting a waiting job cannot start it or release the other waiting jobs", () =>
  Effect.gen(function* () {
    const jobs = yield* fixture;
    yield* jobs.launch("first");
    const stopped = yield* jobs.launch("stopped");
    yield* jobs.launch("waiting");
    yield* Fiber.interrupt(stopped);
    expect(jobs.started).toEqual(["first"]);
    jobs.complete("first");
    yield* TestClock.adjust("10 seconds");
    expect(jobs.started).toEqual(["first", "waiting"]);
  }),
);
