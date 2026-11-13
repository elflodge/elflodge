# Release scope and limitations

The current implementation runs unattended jobs on provisioned Runners in Batches, a job submitted alone being a Batch of one. A Batch's agent supplies instructions, a JSON Schema output contract, run-time and model-spend limits; each job supplies its input, its input files, or both, and labels. Input files are uploaded first, at most 100 MiB each in one request, and named by digest, so a file many jobs share is uploaded once. The hub records events, activity, outputs and usage; callers can pause, resume, cancel and delete jobs, and list jobs by status, label, Batch and custom ID. A Batch runs its first jobs, its Canary, before the rest, and pauses itself when its Canary or too many of its jobs fail; callers can pause, resume and cancel it as one. The CLI calls the hub's HTTP API, and `elflodge stack` runs a hub, a Runner and Postgres on one machine with Docker.

The hub runs on Cloudflare Workers with Postgres through Hyperdrive, or on Node/Docker with Postgres directly. Each Runner is a separate Node process. The hub assigns jobs to connected Runners that report available capacity. A job's journal and Workspace remain on its Runner's host.

## Not in this release

- A Runner's model is chosen when it starts; a job cannot choose its own.
- A job returns one JSON output. It cannot return files; what it writes stays in its Workspace on the Runner's host.
- Results are read by polling the CLI or the HTTP API. There is no callback and no web UI.
- Jobs do not move between hosts. A job runs where it was placed, with its journal and Workspace there.
- Events remain in Postgres. Deployments must account for database growth.
- The Docker hub runs as one process; multiple replicas do not coordinate Runner connections.

## Operating constraints

- A Batch's breaker counts every failure a Runner reports alike, including jobs that fail because their host ran out of memory, so a host that keeps running out of memory can pause the Batches whose jobs it runs. Only jobs failed by their Runner's removal are not counted.
- Run one Runner process per data directory and one process per registered Runner identity. Do not clone a registered data directory onto another live host or use overlapping rolling updates. The application does not yet enforce exclusive ownership; duplicates can execute the same job twice.
- Restart recovery assumes an intact journal and Workspace on the same host. Deleting a journal or restoring an older copy can repeat work and model spend. This differs from an ordinary process restart and is not yet detected reliably.
- A job whose Runner stops communicating, or stops reporting it, keeps the last status its Runner confirmed and shows `statusUnknown` after seven minutes. Nothing moves or ends it meanwhile: pause and cancel requests for that host wait for it to reconnect, and removing the Runner ends its jobs.
- Restoring the hub's database or failing over to a replica that lost acknowledged writes can lose placement decisions. Run IDs fence ordinary stale reports, but do not provide complete reconciliation after a database rollback. A job can be interrupted or placed again. Do not assume exactly-once external effects.
- Deleting a job removes its content at the hub, its Input files' Blobs once no upload under seven days old holds them, and asks its Runner to purge local files. Its Batch, with the agent's instructions and Output contract, stays: a Batch cannot yet be deleted. A silent host cannot confirm that purge. Removing the Runner does not erase files on its host; operators remain responsible for that disk.
- Job commands reach the public internet, but by default not the Runner's host or local and private addresses; a Runner can open ranges or turn the network off. The refusals go by address and assume a Runner on a machine without sensitive services. Model-provider credentials stay in the Runner, outside job sandboxes. This is a single-organization deployment, not a hostile multi-tenant service.
- Per-job memory caps require a suitable Linux user systemd manager. macOS and Docker without that manager have no individual job cap; a Docker memory limit covers the Runner and all its jobs together.
- Linux sandbox support depends on host policy. The Runner's Docker image needs explicit security options, and some Ubuntu/AppArmor combinations are unsupported. Follow the [Runner requirements](../apps/runner/README.md#what-a-host-needs); disabling the sandbox changes the trust boundary.

The default Runner concurrency is eight jobs. Historical density measurements describe particular workloads and environments; they are not a capacity guarantee for an arbitrary deployment.

## Development history

Development began privately in October 2026. This repository retains technical development history edited before the initial public release to remove private metadata and internal context. Pre-release discussions remain private. Commit dates describe the original development; signatures on rewritten commits attest to the edited records. Historical intermediate versions are not release candidates.
