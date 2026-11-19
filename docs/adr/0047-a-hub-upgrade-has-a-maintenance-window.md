# A hub upgrade has a maintenance window

A hub supports only the database schema of its own release. Allow a window in which the hub is down or refuses work while it moves to that schema. Migrations can change what the previous release reads and writes. Running jobs can continue on their Runners while the hub is unavailable.

A Runner retries a lost connection with backoff and jitter, with no attempt limit. Once reconnected, it sends journal entries after the last one the hub recorded (ADR 0026). Across outages of up to about two and a half minutes, Runners caught up within about ten seconds of the new hub serving. Each tool call ran once, the stored events had distinct IDs, and each completed job had one Usage record. A job's own timeout still runs while the hub is down.

Compose replaces the single hub process, and the new hub migrates before opening its listener. [Gitea uses the same upgrade order](https://docs.gitea.com/installation/upgrade-from-gitea/#upgrade-with-docker) for a single instance. On Workers the old version continues serving after setup migrates and while the deployment spreads. Even after deployment, [active Durable Objects can defer code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/) and continue handling Runner reports on old code. The [member-submission migration](../../apps/hub/migrations/20261118T170000_member_submission.ts) renames the submitter columns (ADR 0045). On that schema the v0.10.0 hub returned HTTP 500 on Batch creation, and Runner reports failed on the old column names. Both worked again when the new hub took over.

## Considered options

- Keeping every migration compatible with the previous release would let two hub versions serve together. Even a column rename can then require keeping two columns in sync and dropping one after deployment, as in [GitLab's online column renames](https://docs.gitlab.com/development/database/avoiding_downtime_in_migrations/#renaming-columns). A single hub process and Runners that tolerate its restart give us little reason to stage each change this way.
- Making just the member-submission migration compatible would take more than retaining the old column names and the default submitter kind of `key`. A v0.10.0 hub recording usage for a member's job only knows how to attribute a submission to a key. Supporting it would also mean delaying member submissions or teaching the old writer about members (ADR 0045).
- Having the hub check its schema version and refuse work on a mismatch would require the already-running old version to make that check on API calls, Runner reports and scheduled work. A startup check alone misses the Workers overlap, and checking before a write still leaves time for a migration between the check and the write. The released hub already handles the common mismatch by failing the operation.
- Giving each Worker version its own Postgres login and [Hyperdrive configuration](https://developers.cloudflare.com/hyperdrive/configuration/rotate-credentials/) would let an operator disable the outgoing login and close its existing sessions before migrating. That would exclude even an old Durable Object with an open socket, but adds a database and binding change to every deployment to prevent errors that clear when the new version serves.

## Consequences

Only on Workers, between setup and the new version taking over, the v0.10.0 hub can place or resume a job on the new schema. It writes the new `job.runId` but leaves `jobProgress.runId` on the previous run, or null on first placement. Reports for the new run then cannot refresh its last-reported time. After two minutes the job shows `statusUnknown` with reason `notReported` while its Runner stays connected, until the job ends (ADR 0042). We accept that loss of visibility because the hub still records the job's status and outcome.

Going back requires restoring the pre-upgrade backup with the old hub. The v0.10.0 Docker hub refuses to start on the migrated database because it finds migrations it does not know. The v0.10.0 Worker runs no migrator at startup and would serve requests with the same errors as during the upgrade.

## When to reconsider

Revisit this decision when a deployment outside the project's control runs on Workers or a rolling platform, when callers cannot retry, when migrations take minutes on real data, or when a deployment runs more than one hub process. To exclude the old Worker from a migration window, use the separate login and Hyperdrive configuration per version described above. If the requirement is continuous service through the upgrade, both versions must be able to use the database throughout.
