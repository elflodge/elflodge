# Create a Batch with its first jobs

A caller submitting one job, or a Batch that fits in one request, needs the Batch and jobs to exist together. A stop between creating the Batch and adding its jobs used to leave an empty Batch. `POST /batches` accepts the first jobs with the Batch and commits them together. A retry matches the Batch by its ID and creation content, and each job by its custom ID and content. This also lets a caller supply further jobs on a repeat. Each later request commits separately.

## Considered options

- A separate `batches.submit` would leave the released creation procedure untouched, but give callers two ways to create a Batch and two sets of retry rules to learn.
- A `jobs.submit` that creates a Batch of one would serve only callers submitting one job.
- Putting creation fields on the add would let a POST to a child create its parent. The caller would have to supply the Batch ID, and a missing Batch would return 404 only for some adds.
- A draft Batch sealed across requests would add a state to every Batch for a need that fits one request.

Reconsider a draft if a caller needs atomic submission across several requests.
