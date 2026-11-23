# The hub counts tool calls from the Events it stores

An Organization wants to know how many times its jobs called each tool, above all tools that cost money such as web search: for one job, as a total for a Batch on pages that refresh, and in usage reports after a job is deleted. pi's usage per tool holds tokens and cost, and only for a tool that reports usage; the web search extension the Runner pins reports none. A job's Events hold every call the model asked for, but reading every Event of every job of a Batch is too slow for a page.

The hub counts each job's calls, by tool name, as it stores the Events of each report. It counts them in JavaScript where it already reads the report's lifecycle entries, and the report statement adds the report's count to `jobProgress.toolCalls` under the condition that stores its Events and moves the job's position. An end its Runner reports counts the calls of the ending report's own Events. A report sent again after a lost answer therefore adds nothing, and a job's count is the count over the Events the hub holds.

One finished model-issued call counts under the result message's `toolName`. A result marked `blocked` or `invalid_arguments` counts as zero. Pi 1.6 also writes `tool_unavailable` when a tool has already run and paused, then disappears before it resumes. Pi marks that tool task failed. A missing tool refused at the start counts as zero. A result written by the generation for an unstarted call also counts as zero. Other errors and ambiguous interruptions count because work may already have run. The count measures calls: a single web search can make several provider requests.

Pi 1.6 includes waiting time in `durationMs`, even for refused calls. When reporting a result with diagnostics, the Runner reads its writer from the same journal transaction and includes the tool task's terminal outcome, or `unstarted` when the generation wrote the result. This needs no additional journal writes.

On a Pi upgrade, check both writers of `pi.tool-result`: the tool task that settles its own call and the generation that closes out calls it never started. Check their terminal outcomes and diagnostic codes, including what happens when a paused tool resumes. An unreadable tool result contributes nothing and does not prevent other events from being stored.

The counts are kept in their own columns, each a map from tool name to count: `jobProgress.toolCalls`, the job's count; `job.recordedToolCalls`, the count at its last end, moved with `recordedUsage` in the same statement; and `usageRecord.toolCalls`, the end's own calls, the count less the recorded one, without names that have no new calls. A Runner's usage snapshot replaces `jobProgress.usage` whole on each report, while counts add up with Events, and a tool without pi usage has no entry there, so they are not kept inside `usage`. A Batch reads its jobs' counts summed by name in a subquery of their progress rows apart from its counts and sums, so expanding the names multiplies neither; nothing is kept on the Batch (ADR 0033). A list of Batches leaves it out, as it leaves out `usage`.

A job read carries its count, as each page at the newest end of its Events carries the job (ADR 0048). A deleted job's read, a tombstone while its Runner still owes the deletion of its files, leaves `toolCalls` out, as it leaves out its submitter and failure message: its calls are kept in its Usage records, whose `toolCalls` no report reads yet.

Jobs that existed before the change count from the upgrade: their stored Events are not counted again.

## Considered options

- The Runner counts and reports its jobs' counts: a protocol change, Runners of earlier releases would report none, and the count would be the Runner's rather than one over the Events the hub holds.
- Counting the model's tool requests in `pi.assistant` entries: it counts calls the Runner refused before any search ran.
- Counts inside `usage`: each report's snapshot replaces it whole, and a tool without pi usage has no entry to put a count in.
- Counting at read time from the stored Events: too slow for a Batch's page, and gone once a job is deleted.
- Keeping a deleted job's count beside its other figures in `jobDeletion`: a column for a read that exists only until the Runner deletes the job's files. Reconsider when a page must show a deleted job's calls.

## Consequences

Each report with Events decodes its `pi.tool-result` entries once more, in JavaScript, beside the lifecycle entries already read. A Batch read expands its jobs' counts by name.

## When to reconsider

When pi counts calls in its usage, take the count from there. When calls happen that never reach the Events, as nested or code-mode calls might, the count misses them. When the need becomes billed searches rather than calls, count them where the search extension knows them. When the Batch read is slow at real volume, keep the counts somewhere that does not expand every job's names.
