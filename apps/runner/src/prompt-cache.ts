import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { JobContent } from "contract";
import { Cache, Effect, Latch } from "effect";

/** The stop reasons of a response the provider answered, as pi-durable classifies them. */
const ANSWERED = new Set<AssistantMessage["stopReason"]>(["stop", "length", "toolUse"]);

/**
 * Staggers jobs whose requests begin with the same cacheable prefix on this Runner. The Runner's
 * model and own instructions are fixed; a job's instructions and Output contract (the submit
 * tool's schema) complete the prefix. Inputs and files follow it, so they do not matter.
 */
export const makePromptCacheWarmup = Effect.gen(function* () {
  const context = yield* Effect.context();
  const runSync = Effect.runSyncWith(context);
  // The prefixes a successful response has warmed lately.
  const warm = yield* Cache.make({
    // Bounds what a long-running Runner keeps, far above the few prefixes its jobs use at once; a
    // warm prefix evicted costs one more stagger.
    capacity: 256,
    lookup: (_key: string) => Effect.void,
    // pi-ai asks Anthropic for its default retention: five minutes from the start of a request
    // that writes or reads the prefix. Four from the end of a response stays within that for any
    // response under a minute, and a later response always extends it, whatever order they end in.
    timeToLive: "4 minutes",
  });
  const warming = new Map<string, Latch.Latch>();

  function run<A, E, R>(
    job: Pick<JobContent, "instructions" | "outputContract">,
    start: (callbacks: {
      /** Waits for the prefix to be warmed, if another job is warming it; yielded just before the agent opens. */
      ready: Effect.Effect<void>;
      /** Takes each response of the job's model, failed attempts included. */
      modelResponded: (message: AssistantMessage) => void;
    }) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> {
    return Effect.gen(function* () {
      const key = JSON.stringify([job.instructions, job.outputContract]);
      let owned: Latch.Latch | undefined;
      let waiting: Latch.Latch | undefined;
      const release = () => {
        if (owned && warming.get(key) === owned) {
          warming.delete(key);
          owned.openUnsafe();
        }
      };
      const modelResponded = (message: AssistantMessage) => {
        // pi-durable has no hook for when a response starts, which is when Anthropic makes the
        // cache entry available, so a finished response is the first sign the prefix is cached.
        // Cache reads cannot tell either: the first response to a cold prefix reads none.
        if (!ANSWERED.has(message.stopReason)) {
          // A failed call releases the jobs waiting on this job rather than serializing them, but
          // leaves the prefix cold, and never releases a later job's warm-up.
          release();
          return;
        }
        // Removed first, so the prefix refreshed last is the last the capacity evicts.
        runSync(Cache.invalidate(warm, key).pipe(Effect.andThen(Cache.set(warm, key, undefined))));
        // Whichever job's call warmed the prefix, the jobs waiting for it can start.
        const pending = warming.get(key);
        warming.delete(key);
        pending?.openUnsafe();
      };
      return yield* Effect.gen(function* () {
        // The job's place is taken as it starts, but it waits only at `ready`, so preparing it,
        // such as downloading its Input files, overlaps the first job's call without reordering.
        if (!(yield* Cache.has(warm, key))) {
          waiting = warming.get(key);
          if (!waiting) {
            owned = Latch.makeUnsafe(false);
            warming.set(key, owned);
            // A slow provider must not hold the others for long. The timer belongs to this job,
            // and is cancelled when its call or its end releases them.
            yield* Effect.forkChild(
              Effect.raceFirst(owned.await, Effect.sleep("10 seconds")).pipe(
                Effect.andThen(Effect.sync(release)),
              ),
            );
          }
        }
        return yield* start({ ready: waiting?.await ?? Effect.void, modelResponded });
      }).pipe(Effect.ensuring(Effect.sync(release)));
    });
  }

  return { run };
});

export type PromptCacheWarmup = Effect.Success<typeof makePromptCacheWarmup>;
