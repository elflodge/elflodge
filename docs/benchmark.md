# Benchmark: one Runner against one container per job

How many agent jobs one small server holds, and what each costs in CPU, when the agent loops share a Runner process instead of each getting a container. Measured on Elflodge 0.7.1 in November 2026, on one Hetzner CAX11, with the model's responses replayed from recordings of real runs.

## Setup

- **Server:** a Hetzner CAX11: arm64 (Neoverse-N1), 2 vCPU, 4 GB RAM, Debian 13, about €7 a month. One Runner as a plain process, with real commands in its per-job OS sandboxes, and systemd's `TasksMax` raised. Inessential services were stopped during runs; for the 500 level the server's Tailscale client was stopped too.
- **Hub:** on another machine, so the server's figures are the Runner's alone.
- **Model:** each workload's jobs were run once against a real model (`gpt-6-luna`, 8 jobs at once) and recorded. In the benchmark a replay server on another machine answered every model call with the recorded response at the recorded timing, or slowed down to stand for a slower model. Tools and sandboxes ran for real. A real endpoint cannot be the load source: the one used was full at about 8 jobs at once, and at 1,000 at once its answers changed. Accuracy was measured against the real model at a modest level; the framework's cost, by replay.
- **Baseline:** one plain Pi agent per container, as a developer would run it without Elflodge: the Pi CLI (the same Pi version the Runner uses) in a minimal Debian image with Node and the programs the Runner's image gives jobs, one job per container, `--memory 1g`, on the same server. Each container gets what a Runner job gets: the same tools (read, write, edit, bash, and a submit tool added as a Pi extension), the Runner's instructions followed by the job's input, the same model and thinking level, and the same file layout with the input files in `inputs/`. It lacks what the Runner adds around a job: an OS sandbox for its commands, resuming after a crash, and reporting to the hub.

## Workloads

| Workload          | What each job does                                                  | Pool         | Model turns per job |
| ----------------- | ------------------------------------------------------------------- | ------------ | ------------------- |
| A, extraction     | Read one generated invoice, CV or ticket and submit JSON            | 60 documents | 2                   |
| B, data scripting | Write and run a Python script over a 20,000–60,000-line messy CSV   | 20 files     | 4.4                 |
| C, code fixes     | Fix a Python project with one mutated operator until its tests pass | 31 projects  | 6.9                 |
| D, large data     | B's task on 30–46 MB CSVs                                           | 8 files      | 4.8                 |

Each workload ran at rising levels of jobs at once, two or more rounds each, until a level was no longer clean: a job failed, a model call drifted from its recording more than at healthy levels, or a process was killed for memory.

## Results

| Workload | Limit, jobs at once    | What broke first                 | Memory per open job | Host CPU-s per job                        | Peak throughput   | Accuracy     |
| -------- | ---------------------- | -------------------------------- | ------------------- | ----------------------------------------- | ----------------- | ------------ |
| A        | 500 (model 20× slower) | memory, at 550                   | 6.3 MiB             | 0.17 (recorded speed) – 0.31 (20× slower) | 8.1 jobs/s at 200 | 87% of facts |
| B        | about 300              | CPU from about 75; memory at 400 | 9.8 MiB             | 0.93                                      | 2.0 jobs/s at 100 | 70%          |
| C        | about 400              | CPU from 100; memory at 500      | 7.8 MiB             | 0.64                                      | 2.7 jobs/s at 100 | 90%          |
| D        | about 24               | CPU from 12; memory at 32        | 122 MiB             | 7.2                                       | 0.3 jobs/s at 20  | 76%          |

Memory per open job is the server's memory in use at the peak, less what it used before the first job, divided by the most jobs open in the run. Host CPU-s per job is the server's busy CPU time over the run, divided by the jobs run. Each figure is the best of the clean levels measured. Accuracy measures the model on these tasks, not Elflodge.

## Hundreds at once

Workload A with the model replayed 20 times slower, two rounds of jobs at each level:

| Jobs at once | Result                                                                                                               | Server memory at most | CPU at most |
| ------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------- |
| 425          | all 850 succeeded, clean                                                                                             | 3,571 of 3,817 MiB    | 86%         |
| 475          | all 950 succeeded, clean                                                                                             | 3,706 of 3,817 MiB    | 86%         |
| 500          | all 1,000 succeeded, clean, with the server's Tailscale client stopped                                               | 3,723 of 3,817 MiB    | 90%         |
| 500          | with Tailscale running, in two runs: all jobs succeeded, but one job's sandbox process was killed for memory in each | 3,785 of 3,817 MiB    | 100%        |
| 550          | not clean: 13 job sandboxes were stopped for memory and 13 more timed out                                            | 3,792 of 3,817 MiB    | 100%        |

500 at once was the largest clean level, with the server's Tailscale client stopped: no model call missing or drifting from its recording and no process killed for memory. With Tailscale running, the largest clean level was 475. The Runner's own process peaked at 806 MiB; the rest was the jobs' sandboxes and the system.

## Against one container per job

| Measure                                  | One Runner | Containers                       | Ratio     |
| ---------------------------------------- | ---------- | -------------------------------- | --------- |
| A, jobs open at once (model 20× slower)  | 500        | about 30, with 3% of memory left | about 16× |
| A, memory per open job                   | 6.3 MiB    | about 100 MiB                    | 16×       |
| A, host CPU-s per job (recorded speed)   | 0.17       | 1.70                             | 10×       |
| A, host CPU-s per job (model 20× slower) | 0.31       | 2.36                             | 7.6×      |
| B, host CPU-s per job                    | 0.93       | 2.62                             | 2.8×      |
| C, host CPU-s per job                    | 0.64       | 2.42                             | 3.8×      |
| D, host CPU-s per job                    | 7.2        | 8.3                              | 1.16×     |

A container with a Pi agent costs about 100 MiB however little its job does, and 1–2 CPU-seconds more per job than the same job in a Runner. So the gap is widest when jobs mostly wait on the model and narrows towards the jobs' own work when they compute: D, bound by its own scripts, gains least. The containers were not pushed past 30: 30 left 102 MiB free, less than one more container uses. They ran with the server's Tailscale client running, which holds memory two or three more containers would use, so the ratio under equal conditions is about 16× rather than 500 / 30.

## Throughput and density

At the recorded model speed the host's CPU caps throughput early, so holding more jobs helps only until the CPU is full (A: 5.8 jobs/s at 50 at once, 8.1 at 200, 5.5 at 400, where tool calls began to fail). With a slower model, jobs mostly wait, and the number of jobs to hold is throughput times job duration: replayed 20 times slower, A's throughput kept rising to 3.2 jobs/s at 500 at once. Density matters for slow models and long jobs; CPU per job matters for fast ones.

## Limits of these numbers

- These are particular workloads on one machine, not a capacity guarantee. The job sandboxes, the model's speed and the jobs' own work set the limits.
- Under replay a job whose sandbox failed would still finish, since its recorded turn is answered regardless. Tool failures were counted from the replay server's log of tool results that differed from the recording. In the containers, Pi's own bash tool words empty and truncated output differently from the Runner's, so their tool results differ from the recordings in wording; every container job took its recorded turns and wrote its output.
- The benchmark harness is not published.
