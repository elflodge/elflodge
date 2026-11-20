# hub

The central service every caller and Runner connects to. It runs on Cloudflare Workers, with Postgres through Hyperdrive, and as a Node process in a Docker image, with Postgres directly.

On Workers, create the Hyperdrive configuration with caching disabled, `vp exec wrangler hyperdrive create <name> --connection-string="<url>" --caching-disabled` in this folder, and set its ID in `wrangler.jsonc`; turn caching off on an existing one with `vp exec wrangler hyperdrive update <id> --caching-disabled`. By default Hyperdrive caches eligible reads for a minute, serves them up to 15 seconds longer while it refreshes them, and keeps serving them after a write, so the hub could still accept a session that ended or a key that was revoked, or report a job's old status.

## Settings

On Workers, set them in `wrangler.jsonc` and as Wrangler secrets; for `wrangler dev`, copy `.dev.vars.example` to `.dev.vars`. In Docker, set them as environment variables.

- `BETTER_AUTH_SECRET` (required): signs members' sessions. Generate one with `openssl rand -base64 32`.
- `HUB_URL` (required): the hub's public URL, the same setting a Runner dials. Better Auth uses it as its base URL, for its links, its trusted origin and whether session cookies are `Secure`; the hub also refuses a member's request that a form on another site could send unless it comes from this origin. Without either, the hub logs what to set: in Docker it exits, and on Workers it answers 503 to every request that needs them, while `/healthz`, the dashboard's files and the redirect from `/` still answer.
- `CLIENT_IP_HEADER`: the request header carrying the client's IP address, for Better Auth's rate limits: `cf-connecting-ip` on Workers, `x-real-ip` on Railway. Unset, Better Auth reads `x-forwarded-for`, and a request whose address it cannot resolve shares one rate-limit bucket per path.
- `REPORT_INTERVAL_MS`: how often each Runner reports its jobs' new events, usage and activity, in milliseconds; 3000 by default. A job's activity is up to one interval old.
- `TRUSTED_PROXIES`: the proxies in front of the hub, as IPs or CIDRs separated by commas. A forwarded chain is read from the right past these, so a client cannot name its own address; unset, only a chain of one address counts.
- `JOB_RUN_TIMEOUT_SECONDS_DEFAULT` and `JOB_RUN_TIMEOUT_SECONDS_MAX` set the default and maximum timeout for each run, in seconds (1800 and 86400 by default).
- `JOB_MODEL_BUDGET_USD_DEFAULT` and `JOB_MODEL_BUDGET_USD_MAX` set the default and maximum lifetime model budget for each job, in US dollars (1 and 10 by default).

Members and API keys with `job:read` can read these four settings at `GET /jobs/limits`. Creating a Batch uses the default for each limit left out. Each new job takes its Batch's stored limits. Resuming a job keeps each limit left out, even if the maximum has since been lowered. The hub checks limits supplied at creation or resume against the current maxima. It refuses a default above its maximum.

In Docker, also:

- `DATABASE_URL` (required): the hub's Postgres database.
- `ADMIN_EMAIL` and `ADMIN_PASSWORD`: the owner to create on first start, when no Organization exists; set both or neither. Without them, the hub prints a setup link as it starts, with which you create the owner in the dashboard; each start replaces it with a new one. Once the Organization exists, the hub ignores both.
- `PORT`: where the hub listens; 8787 by default.
- `HOST`: the address the hub listens on; every interface by default.

## Docker

Each release publishes the hub's image as `ghcr.io/elflodge/elflodge-hub`. Run one container per hub: it runs as a single process. Its health check fetches `/healthz`, which answers once the hub serves requests; platforms that ignore the image's check, such as Kubernetes, can probe the same path. To build it from the repository's root:

```sh
docker build . --target hub --tag elflodge-hub
```

`vp run build` builds the same Node hub into `dist/`, and `vp run start` runs it.

## Scripts

Run with `DATABASE_URL` set to the hub's database.

- `vp run setup`: applies migrations, then, unless the Organization exists, creates it and its owner from `ADMIN_EMAIL` and `ADMIN_PASSWORD`, or, without them, prints a setup link to the hub at `HUB_URL`, with which you create the owner in the dashboard. Run it before deploying; running it again replaces the link. It prints the link only when stdout is a terminal. Some CI runners allocate a terminal and log its output, so set `ADMIN_EMAIL` and `ADMIN_PASSWORD` for CI deploys.
- `vp run reset-password`: sets a new password, `ADMIN_PASSWORD`, for the account with `ADMIN_EMAIL`, including a former member. See [membership and account recovery](../../docs/deploy.md#membership-and-account-recovery).

These start Postgres themselves with Testcontainers:

- `vp run db:types`: regenerates the database types from the migrations.
- `vp run db:draft-auth-migration`: prints the SQL Better Auth still needs, to copy into a migration after a Better Auth upgrade.
