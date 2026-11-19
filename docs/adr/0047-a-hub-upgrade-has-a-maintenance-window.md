# A hub upgrade has a maintenance window

A hub supports only the database schema of its own release. Allow a window in which the hub is down or refuses work while it moves to that schema. Migrations can change what the previous release reads and writes. Running jobs can continue on their Runners while the hub is unavailable.

A Runner retries a lost connection with backoff and jitter, with no attempt limit. Once reconnected, it sends journal entries after the last one the hub recorded (ADR 0026). Across outages of up to about two and a half minutes, Runners caught up within about ten seconds of the new hub serving. Each tool call ran once, the stored events had distinct IDs, and each completed job had one Usage record. A job's own timeout still runs while the hub is down.

Compose replaces the single hub process, and the new hub migrates before opening its listener. Gitea uses the same upgrade order for a single instance. On Workers, setup migrates while the previous version is still serving. The overlap lasts through deployment and can last longer for active Durable Objects handling Runner reports. With the v0.10.0 hub on the new schema, creating a Batch returned HTTP 500 and reports failed on renamed submitter columns. Both worked again when the new hub took over. [Gitea upgrades](https://docs.gitea.com/installation/upgrade-from-gitea/#upgrade-with-docker) · [Durable Object code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/)

## Considered options

- Keeping every migration compatible with the previous release would let two hub versions serve together. Even a column rename can then require keeping two columns in sync and dropping one after deployment, as in GitLab's online migrations. A single hub process and Runners that tolerate its restart give us little reason to stage each change this way. [GitLab's online column renames](https://docs.gitlab.com/development/database/avoiding_downtime_in_migrations/#renaming-columns)
- Making just the member-submission migration compatible would take more than retaining the old column names and the default submitter kind of `key`. A v0.10.0 hub recording usage for a member's job only knows how to attribute a submission to a key. Supporting it would also mean delaying member submissions or teaching the old writer about members (ADR 0045).
- Having the hub check its schema version and refuse work on a mismatch would require the already-running old version to make that check on API calls, Runner reports and scheduled work. A startup check alone misses the Workers overlap, and checking before a write still leaves time for a migration between the check and the write. The released hub already handles the common mismatch by failing the operation.
- Giving each Worker version its own Postgres login and Hyperdrive configuration would let an operator disable the outgoing login and close its existing sessions before migrating. That would exclude even an old Durable Object with an open socket, but adds a database and binding change to every deployment to prevent errors that clear when the new version serves. [Hyperdrive credential rotation](https://developers.cloudflare.com/hyperdrive/configuration/rotate-credentials/)

## Consequences

There is one accepted case where the effect outlasts the Workers overlap. If the v0.10.0 Worker resumes a job after setup and before the new code takes over, it changes `job.runId` and leaves `jobProgress.runId` on the previous run. The new hub can record the job's status and outcome, but reports for the new run cannot refresh its last-reported time. Once that time is stale, the job can show `statusUnknown` with reason `notReported` until it ends (ADR 0042).

Going back requires restoring the pre-upgrade backup with the old hub. Starting the v0.10.0 hub against the migrated database fails because its migrator finds migrations it does not know.

## When to reconsider

Revisit this decision when a deployment outside the project's control runs on Workers or a rolling platform, when callers cannot retry, when migrations take minutes on real data, or when a deployment runs more than one hub process. To exclude the old Worker from a migration window, use the separate login and Hyperdrive configuration per version described above. If the requirement is continuous service through the upgrade, both versions must be able to use the database throughout.
