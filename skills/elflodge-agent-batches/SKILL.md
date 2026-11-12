---
name: elflodge-agent-batches
description: Automate repeated tasks with parallel agents through Elflodge (formerly agent-batch). Use for batch document extraction, classification, enrichment, structured outputs, and submitting or recovering Elflodge jobs.
---

# Elflodge Agent Batches

[Website](https://elflodge.com) · [GitHub](https://github.com/elflodge/elflodge)

Turn a repeated task into independent agent jobs with structured results. Each job has files and shell tools in an isolated workspace. Keep deterministic work in ordinary code; use agents for the parts that need judgment.

Take one path:

- **New work**: follow [Start new work](#start-new-work) in order, then [Collect](#collect-and-recover).
- **A Batch that already exists** (a wait that ended, a failure, a pause, results to fetch): start at [Collect](#collect-and-recover) with its Batch ID. Its jobs are already submitted, so leave them in place and work from that ID.

## Start new work

### 1. Prepare the unit of work

Identify one unit of work, the files it needs, and what a correct answer looks like. Choose an output schema that represents uncertainty: for extraction, allow `null` for missing facts and include a reason when useful. Put task definitions and edge cases in the instructions; field names in the schema carry too little.

Note whether the job needs to read images or rendered PDF pages, fetch web pages, or search the web. Step 2 checks the setup against those needs.

For PDF extraction or a runnable sample batch, read [the invoice example](references/invoice-extraction.md) for tooling requirements, commands and output checks.

Done when you can state the unit, its input files, the schema, and the needs noted above.

### 2. Connect and check the setup

Use an existing hub when `ELFLODGE_URL` and `ELFLODGE_API_KEY` are set, and keep credentials out of output. Otherwise, with Docker and Node 22.19 or later, check `npx elflodge stack status`, then run `npx elflodge stack start` if needed. First start offers provider sign-in; even the default free OpenRouter models need authentication. The owner completes interactive authentication.

The installed setup is the authority. A deployment may still run an older release such as 0.9, so where its `npx elflodge --help` or its reported behavior differs from this skill or from the [CLI reference](https://github.com/elflodge/elflodge/blob/main/docs/cli.md) on `main`, follow the installed setup. Read the [release scope](https://github.com/elflodge/elflodge/blob/main/docs/release-scope.md) before suggesting capabilities beyond this workflow.

If step 1 noted a need for images, web pages or search, confirm this setup provides it, using [What jobs can reach](#what-jobs-can-reach). Sources, in order:

1. What `stack start` reports for the local stack.
2. The Runner's operator. The hub lists each Runner's capabilities at `GET /runners`, which requires member authentication; the job API key does not grant it, and the CLI documents no runners command.

Jobs go to any Runner with a free slot, whatever its model or web setup, so a need must hold for every Runner the hub may use.

Work with the model, search and network the setup already has. When a need is unmet, tell the user which one and what the operator would change; a provider key that happens to be available is not a decision to use it.

Continue when the hub answers and each requirement needed for the work is supported. If a requirement is unmet, resolve the setup or adapt the task before submitting dependent jobs.

### 3. Pilot

Run a small pilot as its own Batch: ordinary and difficult cases with known expected answers. The pilot tests substantive quality. The built-in first-five Canary tests only execution: it catches jobs that fail to run, establishes nothing about whether answers are right, and does not pause for review when it succeeds.

When the user already has a tested agent, reuse that work as the pilot evidence.

Compare every pilot output with its source and expected answer. If you revise instructions or the schema, run a new pilot Batch and check the revised outputs before scaling. Proceed when the task’s acceptance criteria are met, or report the remaining limitations so the user can decide whether they are acceptable.

### 4. Run the batch

Expand the intended paths and confirm the job count before submitting. Each file after `--each` becomes one job. Each directory becomes one job holding that directory's files, so a parent directory yields one job, not one per file. Use a directory per job for related files that must be reasoned over together. A glob such as `invoices/*.pdf` is not recursive. For deep or very large collections, inventory the files first and use the CLI reference's JSONL submission; a shell argument list has a size limit. Keep source-to-preprocessed-input mappings, and keep sidecar files out of the job list.

Give the full run its own stable Batch ID. Instructions and schema are immutable for a Batch; use a new ID after changing them. Repeating the same command with the same ID and unchanged inputs fills in missing submissions without duplicating existing jobs, and leaves successful jobs as they are.

Scale within the user's intended workload and model budget. Default Runner concurrency is eight. Raising it needs host resources and provider capacity, so choose it from measured workload behavior, not from input count.

After submission, verify the Batch ID and submitted count match the intended work.

## Collect and recover

`output.jsonl` holds success records shaped as `{customId, status, output}`; `error.jsonl` holds the other outcomes, with failure reasons where available. A file is absent when it has no records. Check `output`, not the wrapper, against the task's expected answer: schema validation checks structure, not truth or completeness.

For an existing Batch, first inspect `batches get --id ID`. Recover the original submission details from saved files; ask for missing details rather than inventing them. To collect, repeat the original `batches submit` command with the same ID, inputs, instructions and schema, `--wait`, and a fresh `--output-dir`. A destination that already holds `output.jsonl` or `error.jsonl` is refused, including after a partial save. Keep those files as evidence and pick a new directory each attempt.

When the waiter exits:

- `0`: all jobs succeeded. Check substantive quality next.
- `1`: a job failed, the Batch was cancelled or its breaker paused it, or saving results failed. Read the actual reason before acting: `batches get --id ID` for the Batch, `jobs get --id ID` or `jobs events --id ID` for a job. For a paused Batch, address the cause, then follow the CLI's resume guidance.
- `124`: the wait timed out and jobs may still be running. Inspect, then collect as above. The Batch is intact; only the local wait ended.
- `130` / Ctrl-C: waiting stopped, not the Batch. Inspect and collect as above.

A job that failed with `journalLost` had a missing or stale journal, and resume cannot replay it. Its agent may already have done part of the work, including anything it sent outside the workspace. Inspect completed work and possible external effects before proposing a rerun. Report affected IDs and unresolved effects; a resubmission under a new ID is a fresh execution, not a continuation.

`stack stop` preserves local data. `stack delete` destroys volumes and credentials without confirmation and is never a recovery step.

Done when you have reported: submitted count, outcomes by kind, output paths, unresolved failures, and which semantic checks you performed. A submission that returned successfully is not a completed batch.

## What jobs can reach

These are set per Runner by its operator and apply to every job on it.

- **Model**: one per Runner, not per job. Images among a job's inputs, and PDF pages the agent renders, reach the model as images, so those jobs need a model that accepts images.
- **Commands**: by default they reach the public internet. The Runner's host and local or private addresses are refused unless the operator opened specific ranges. Consult the [Runner network documentation](https://github.com/elflodge/elflodge/blob/main/apps/runner/README.md#network) for restrictions, exceptions and proxy limitations.
- **Web pages**: the Runner image includes pi-web-access, whose `fetch_content` reads web pages and PDFs.
- **Search**: configured separately from the image and from the network. By default it is on only when the Runner's model runs on a ChatGPT subscription, and searches go through that subscription. An operator can name search providers instead, which may incur charges outside the job's model budget, or supply custom settings, in which case the subscription default does not apply.
- **`RUNNER_NETWORK=none`**: commands get no network and `fetch_content` is off. If search is enabled, `web_search` and `source_check` still fetch the pages they find. Describe such a Runner by these three facts.
