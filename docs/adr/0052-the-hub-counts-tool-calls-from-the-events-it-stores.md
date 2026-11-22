# The hub counts tool calls from the Events it stores

An Organization wants to know how many times its jobs called each tool, above all tools that cost money such as web search: for one job, as a total for a Batch on pages that refresh, and in usage reports after a job is deleted. pi's usage per tool holds tokens and cost, and only for a tool that reports usage; the web search extension the Runner pins reports none. A job's Events hold every call the model asked for, but reading every Event of every job of a Batch is too slow for a page.

The hub counts each job's calls, by tool name, as it stores the Events of each report. It counts them in JavaScript where it already reads the report's lifecycle entries, and the report statement adds the report's count to `jobProgress.toolCalls` under the condition that stores its Events and moves the job's position. An end its Runner reports counts the calls of the ending report's own Events. A report sent again after a lost answer therefore adds nothing, and a job's count is the count over the Events the hub holds. Neither the Runner nor the protocol changes, so Runners of earlier releases are counted too.

One call counts for each `pi.tool-result` entry, under its message's `toolName`, the name pi keys a tool's usage by, unless the call is known not to have run. pi's harness writes the message's `durationMs` only when it ran the tool, timing `execute`, so a result with a duration counts whatever its diagnostics say: a tool's own diagnostics share the list with the harness's and could carry the same codes. For a result without one, its diagnostic codes are the inference. It does not count with `blocked`, a hook refused it, as the Runner's web-access guard does; `invalid_arguments`; `tool_unavailable`; or `abandoned`, its caller ended with a restart before it started. It counts with `interrupted` or `restart_limit`, which may have run, and with a code the hub does not know: the count errs high rather than miss a paid call. It counts with `aborted` too, which pi writes both for a call cut off while it ran and for one it knows never started, such as the calls of a round run one at a time that a stop left unstarted; the result does not tell them apart. It counts calls, not what a provider bills: one `web_search` call can run several queries and fall back from one provider to another.

This is the hub's first reading of a pi entry, and it reads only the entry's kind, its message's `toolName` and `durationMs`, and its diagnostics' codes. An entry of another shape counts as nothing and never refuses its report, as does a tool name Postgres cannot hold as a `jsonb` key, which would otherwise fail the statement for every job in the report. On a pi upgrade, check pi-durable's two writers of the entry, `appendToolResult` in `dist/harness/tool.js`, called when a call settles, and the abort of a generation in `dist/harness/generation.js`, which writes results for the calls it never started: that `pi.tool-result` and those fields keep their names and meaning, that `durationMs` is still written only for a call the harness ran, and whether the harness gains a code for a call it did not run.

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
