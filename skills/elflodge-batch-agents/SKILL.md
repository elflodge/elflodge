---
name: elflodge-batch-agents
description: Run repeated tasks through Elflodge (formerly agent-batch) with parallel agents and structured results. Use for document extraction, classification, enrichment, and submitting or recovering Elflodge batches.
---

# Elflodge batch agents

Turn a repeated task into independent agent jobs with structured results. Each job has files and shell tools in an isolated workspace. Keep deterministic work in ordinary code; use agents for the parts that need judgment.

## Prepare the work

Identify one unit of work, the files it needs, and what a correct answer looks like. Choose an output schema that represents uncertainty rather than encouraging guesses: for extraction, allow `null` for missing facts and include a reason when useful. Put task instructions, definitions and edge cases in the instructions, not just field names in the schema.

Job shell commands have no network access by default; web research needs a setup that supports it.

For PDF extraction or a runnable sample batch, read [the invoice example](references/invoice-extraction.md) for tooling requirements, commands and output checks.

## Connect

Use an existing hub when configured through `ELFLODGE_URL` and `ELFLODGE_API_KEY`; do not print credentials. Otherwise, with Docker and Node 22.19 or later, check `npx elflodge stack status`, then run `npx elflodge stack start` if needed. First start offers provider sign-in; even the default free OpenRouter models need authentication. Let the owner complete interactive authentication when needed.

For flags and behavior, consult `npx elflodge --help` and the [CLI reference](https://github.com/elflodge/elflodge/blob/main/docs/cli.md). Read the [release scope](https://github.com/elflodge/elflodge/blob/main/docs/release-scope.md) before suggesting capabilities beyond this workflow. The model is configured per Runner, not per job.

## Try representative jobs, then run the batch

Prepare a small pilot containing ordinary and difficult cases with expected answers. A pilot is a separate Batch: the built-in first-five Canary catches execution failures, but does not establish factual quality or wait for a human review when it succeeds. Compare pilot outputs with the source before scaling. When the user already has a tested agent, reuse that work.

Each file after `--each` becomes one job. Each directory becomes one job with that directory's files; passing a parent directory does not create a job per file. Expand the intended paths and check the job count before submission. For related files that must be reasoned over together, use a directory per job. A glob such as `invoices/*.pdf` is not recursive. For deep or very large collections, inventory the files first and consult the CLI reference for JSONL submission rather than assuming an arbitrarily large shell argument list will fit. Keep source-to-preprocessed-input mappings and exclude sidecar files from the job list.

Give the full run its own stable Batch ID. Instructions and schema are immutable for a Batch; use a new ID after changing them. Repeating the same command with the same ID and unchanged inputs fills in missing submissions without duplicating existing jobs. It does not rerun successful jobs with revised reasoning.

Scale within the user's intended workload and model budget. The default Runner concurrency is eight, not hundreds. Higher concurrency requires sufficient host resources and provider capacity; choose it from measured workload behavior, not input count alone.

## Collect and inspect

`output.jsonl` contains success records shaped as `{customId, status, output}`; `error.jsonl` contains the other outcomes and failure reasons where available. A file is absent when it has no records. Inspect `output`, not the wrapper, against the task's expected answer. Schema validation checks structure, not truth or completeness.

Report submitted count, outcomes, output paths, unresolved failures and what semantic checks were performed. Do not report a whole batch as complete merely because submission returned successfully.

When the waiter exits:

- `0`: all jobs succeeded. Still check the task's substantive quality.
- `1`: a job failed, the Batch was cancelled or its breaker paused it, or saving results failed. Read the actual reason before retrying. Inspect the Batch with `batches get --id ID`, and a job with `jobs get --id ID` or `jobs events --id ID`; use the CLI's resume guidance for a paused Batch after addressing the cause.
- `124`: the wait timed out. Jobs may still be running. Inspect, then repeat the original `batches submit` command with the same ID, inputs, instructions and schema, `--wait`, and a fresh `--output-dir` to collect results. Do not create a replacement Batch just because the local wait ended.
- Ctrl-C stops waiting, not the running Batch.

Existing `output.jsonl` or `error.jsonl` files make the destination unusable for another collection attempt. Preserve them and choose a fresh output directory when resuming, including after a partial save. Do not delete evidence to make a retry work. `stack stop` preserves local data; `stack delete` destroys volumes and credentials without confirmation and is not a recovery step.
