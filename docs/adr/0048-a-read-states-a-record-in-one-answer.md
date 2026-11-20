# A read states a record in one answer

Read a record in one SQL statement and return the facts the hub derives about it in that record’s own answer. A caller can then describe the record from one snapshot without sampling another read.

A member reading a Batch can see how many jobs are queued and how many are waiting for its Canary. Both counts come from the same snapshot, whether the member reads the Batch by ID or in a list.

The Batch’s `jobsWaitingForCanary` counts the jobs whose `blockedBy` would say `batchCanary`. Each also counts toward `jobCounts.queued`. `pausedBy` tells whether a caller or the failure breaker paused the Batch.

A member following a job’s Events sees the job as it stood when the hub read those Events. A page at the newest end of the journal carries the job from the same statement, with the same fields as a read by ID. Reading earlier Events leaves the job on screen alone. Following continues after a run ends so the member sees a resume or deletion from elsewhere.

## Considered options

- Read the newest queued job to see whether it is waiting for the Canary. A breaker resume starts a new Canary with the oldest unsent queued jobs. Near the end of the queue these can be the newest jobs in the Batch. If a member then resumes an older job paused on its own, it waits outside that Canary while the newest queued job is free to run. Sampling misses the block even if nothing changes between reads.
- Return a boolean for jobs waiting for the Canary. The dashboard and CLI show how many are waiting.
- Return a count for each blocking reason. The dashboard and CLI use the Canary count and show the pause reason from `pausedBy`. A Batch can have at most one pause reason at a time. A caller that needs the number of jobs held by that pause could use a single additional count alongside `pausedBy`.
- Give the Batch a single `blockedBy`. Its pause would repeat `pausedBy`, and the value would mean two different things. A pause blocks every unsent queued job, while a Canary blocks only those outside it. An older client would reject the whole Batch on seeing an unfamiliar enum value.
- Order two answers by a revision or position. Knowing which answer came later still cannot tell the caller how many jobs were blocked at either moment. ADR 0026 rejected a per-job revision counter in the Runner protocol because nothing moves backwards within a run. The run and its forward-only intents already carry the order. Neither decision adds a counter.
- Keep reading the job and its Events separately. Either answer can arrive first. A caller that sees different statuses must read the job again, and matching statuses say nothing about whether its activity or usage has changed.
- Return the position of the last Event the job read reflects. Only a Runner’s report adds Events. The hub can resume a job, pause or cancel an unsent job, cancel a paused job or its Batch, or end a removed Runner’s jobs without adding an Event. A Runner can report a failure its journal could not record, or new usage without an Event. Time alone can change `statusUnknown` and `runner.connected`. Equal positions leave those changes unordered.
- Carry just status, usage and controls on the Events page. A member would still read the rest of the job, including its Output and activity, from another moment.

## Consequences

A single Batch read counts jobs waiting for its Canary alongside status and usage. A list counts unsent queued jobs outside the Canary of each unpaused Batch it shows whose Canary is unfinished. Both avoid an extra hub call for each Batch a member sees.

The job can be much larger than a page of Events. An ascending page carries it once caught up, and a descending page carries it when read from the newest end. Every page keeps the status read in its statement. Released CLI clients require it to read the Events.

## When to reconsider

Reconsider computing the counts at read time if scanning queued jobs on a list page becomes too costly at the sizes deployments use. Any stored counts would need to stay correct through placement, job controls, and changes to the Batch’s pause and Canary.

Reconsider which Events pages carry the job if a byte cap on Output makes it cheap to include on every page.
