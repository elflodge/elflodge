import type { JobContent } from "contract";
import { Cache, Clock, Context, Effect, Latch } from "effect";

/**
 * Staggers jobs with the same provider-cache prefix on this Runner. Its model and unattended
 * prompt are fixed; instructions and the Output contract (the submit tool's schema) vary by job.
 * Inputs and files follow that prefix, so they do not split a group.
 */
export const makePromptCacheWarmup = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const runSync = Effect.runSyncWith(Context.make(Clock.Clock, clock));
  const warm = yield* Cache.make({
    capacity: Infinity,
    lookup: (_key: string) => Effect.void,
    // Anthropic's default five minutes is the shortest common provider cache lifetime. A
    // successful call refreshes this allowance; merely starting another job does not.
    timeToLive: "5 minutes",
  });
  const warming = new Map<string, Latch.Latch>();

  function run<A, E, R>(
    job: Pick<JobContent, "instructions" | "outputContract">,
    start: (callbacks: {
      /** Waits for the group's warm-up; yielded just before the agent opens. */
      ready: Effect.Effect<void>;
      modelCallCompleted: (succeeded: boolean) => void;
      agentStarted: () => void;
    }) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> {
    return Effect.gen(function* () {
      const key = JSON.stringify([job.instructions, job.outputContract]);
      let owned: Latch.Latch | undefined;
      const started = Latch.makeUnsafe(false);
      const release = () => {
        if (owned && warming.get(key) === owned) {
          warming.delete(key);
          owned.openUnsafe();
        }
      };
      const completed = (succeeded: boolean) => {
        // Cache reads cannot signal readiness: the first response to a cold prefix need not read
        // any cached tokens. A failed call releases its peers too, rather than serializing
        // failures, but leaves the prefix cold, so the next job warms it again.
        if (succeeded) runSync(Cache.set(warm, key, undefined));
        const waiting = warming.get(key);
        warming.delete(key);
        waiting?.openUnsafe();
      };
      return yield* Effect.gen(function* () {
        // The job's place is taken as it starts, but it waits only at `ready`, so preparing it,
        // such as downloading its Input files, overlaps the first job's call without reordering.
        let waiting: Latch.Latch | undefined;
        if (!(yield* Cache.has(warm, key))) {
          // Cache expires lazily. Enumerating its keys discards expired prefixes, including ones
          // no job uses again, without evicting a still-warm prefix or keeping a cleanup timer.
          Array.from(yield* Cache.keys(warm));
          waiting = warming.get(key);
          if (!waiting) {
            owned = Latch.makeUnsafe(false);
            warming.set(key, owned);
            // A slow provider must not serialize the group indefinitely. The timer belongs to
            // this startup, and is cancelled when its first call or the job releases the group.
            yield* Effect.forkChild(
              Effect.raceFirst(
                owned.await,
                started.await.pipe(Effect.andThen(Effect.sleep("10 seconds"))),
              ).pipe(Effect.andThen(Effect.sync(release))),
            );
          }
        }
        return yield* start({
          ready: waiting?.await ?? Effect.void,
          modelCallCompleted: completed,
          agentStarted: () => started.openUnsafe(),
        });
      }).pipe(Effect.ensuring(Effect.sync(release)));
    }).pipe(Effect.provideService(Clock.Clock, clock));
  }

  return { run };
});

export type PromptCacheWarmup = Effect.Success<typeof makePromptCacheWarmup>;
