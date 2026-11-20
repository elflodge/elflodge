# A read states a record in one answer

Read a record in one SQL statement and return the facts the hub derives about it in that record’s own answer. A caller can then describe the record from one snapshot without sampling another read.

A member reading a Batch can see how many jobs are queued and how many are waiting for its Canary. Both counts come from the same snapshot, whether the member reads the Batch by ID or in a list.

The hub decides what blocks each queued job from being sent to a Runner. It applies the same rule when counting a Batch’s jobs by reason as when reading a job’s `blockedBy`. The Batch carries one count per reason, zero included. Each of those jobs also counts toward `jobCounts.queued`.

## Considered options

- Read the newest queued job to see whether it is waiting for the Canary. A breaker resume starts a new Canary with the oldest unsent queued jobs. Near the end of the queue these can be the newest jobs in the Batch. If a member then resumes an older job paused on its own, it waits outside that Canary while the newest queued job is free to run. Sampling misses the block even if nothing changes between reads.
- Return a boolean for jobs waiting for the Canary. It answers one sentence. Showing how many jobs are waiting needs a count anyway, and each other reason would need a field of its own.
- Give the Batch a single `blockedBy`. Its pause would repeat `pausedBy`, and the value would mean two different things. A pause blocks every unsent queued job, while a Canary blocks only those outside it. An older client would reject the whole Batch on seeing an unfamiliar enum value. With counts it drops an unfamiliar key and reads the rest.
- Order two answers by a revision or position. Knowing which answer came later still cannot tell the caller how many jobs were blocked at either moment. ADR 0026 rejected a per-job revision counter in the Runner protocol because nothing moves backwards within a run. The run and its forward-only intents already carry the order. Neither decision adds a counter.

## Consequences

Counting blocks reads the Batch’s queued jobs, as counting statuses in ADR 0033 reads its jobs. A single Batch read counts blocks alongside status and usage. A list counts the unsent queued jobs of the Batches it shows. Both avoid another hub call for each Batch a member sees.

## When to reconsider

Reconsider computing the counts at read time if scanning queued jobs on a list page becomes too costly at the sizes deployments use. Any stored counts would need to stay correct through placement, job controls, and changes to the Batch’s pause and Canary.
