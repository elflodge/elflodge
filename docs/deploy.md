# Deploying Elflodge

The README starts one machine with `npx elflodge stack start`. This guide covers host requirements, the local stack and a Docker Compose deployment. It also explains how to upgrade on rolling platforms and Cloudflare Workers, connect Runners and callers on other machines, and call the API directly.

## Host requirements

Docker Engine 29 or later with Compose 5 or later, Node 22.19 or later, and `jq` for the README's examples. Use current patch releases of [Docker Engine](https://docs.docker.com/engine/install/) and [Compose](https://docs.docker.com/compose/install/).

On Ubuntu 24.04, let the Runner's job sandboxes create user namespaces before starting it: `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, plus a file in `/etc/sysctl.d` to keep the setting across reboots. On Ubuntu 25.04 and later, jobs cannot run in a sandbox yet. [The Runner's README](../apps/runner/README.md) explains both, and covers running a Runner outside Docker.

## One machine: the local stack

`npx elflodge stack start` runs a hub, its Postgres and a Runner from the images released with the CLI, in the background, and keeps running after the terminal closes. It returns once the hub is healthy and the Runner has started. On its first start it creates the hub's owner and an API key for jobs and the Runner listing; `elflodge` commands use that hub and key while `ELFLODGE_URL` and `ELFLODGE_API_KEY` are unset, and `npx elflodge stack env` prints both for other clients, such as `curl`. If your jobs key predates `runner:read`, sourcing `stack env` selects that key and `elflodge runners list` gets a 401. Unset both variables so the CLI uses the separate listing key created on upgrade.

- **Dashboard.** Open `http://localhost:8787/dashboard/` (use your chosen port if you set `--port`) and sign in as `owner@example.com`. Run `npx elflodge stack initial-password` for the initial password. After changing it in the dashboard, use the password you chose. The hub's origin check refuses sign-in from `http://127.0.0.1:<port>`.
- **Models.** The default is OpenRouter's free models. Choose another with `--provider` and `--model`, as Pi names them, such as `--provider anthropic --model claude-sonnet-5-5`. On first use the command offers provider login and saves it in the Runner's volume; keys are hidden as you type. `npx elflodge stack login --provider <provider>` adds or replaces one provider's credential, offering an API key or account sign-in where Pi supports them; `--with-api-key` reads a key from stdin. To supply a key from your environment instead, forward its variable by name: `OPENROUTER_API_KEY="$MY_KEY" npx elflodge stack start --env OPENROUTER_API_KEY`, where `MY_KEY` already holds the key, so it stays out of your shell history.
- **Web access.** Jobs' agents read web pages and PDFs with pi-web-access. Web search is off, except through a ChatGPT subscription the model runs on. To let jobs search through a provider, name it and forward its key: `BRAVE_API_KEY="$MY_BRAVE_KEY" npx elflodge stack start --search brave --env BRAVE_API_KEY`. A forwarded key alone does not turn search on, and `--reset-search` goes back to the default. The Runner's README covers [extensions](../apps/runner/README.md#extensions).
- **Status and logs.** `npx elflodge stack status` shows whether the stack is running, the hub's URL and health, the image versions in use and the Runner's authentication source. `npx elflodge stack logs` prints the logs; `--follow` keeps printing them. A job stays `queued` until a Runner has room for it, and the Runner's log shows any error that keeps it from connecting.
- **Stopping.** `npx elflodge stack stop` keeps the containers, data and credentials for the next start. `npx elflodge stack delete` removes the database and Runner volumes, including saved logins, without a prompt.
- **Upgrading.** Let the local Runner's jobs finish before running `npx elflodge stack stop`, which stops the Runner, hub and Postgres. A restarted Runner recovers its jobs from their journals, but a tool call cut off by the stop gets an `interrupted` result. Back up the stopped volumes. If you pin the images with `ELFLODGE_VERSION`, set it to the target version or unset it before starting, including when going back. Run `npx elflodge@<new-version> stack start`. It starts Postgres on its existing volume, waits up to 60 seconds for the hub to migrate and become healthy, then starts the matching Runner with its saved data and logins. If you forwarded variables with `--env`, have their values in your environment again. To go back, restore the pre-upgrade volumes and start with the previous CLI version.

## Several machines: Docker Compose

The hub and a Runner from their published images on one machine, as a deployment that other machines' Runners and callers can reach once the hub is opened to them, as [Runners on other machines](#runners-on-other-machines) shows. It needs Docker Engine 29 or later and Compose 5 or later, `curl`, `jq` and `openssl`, and on Ubuntu 24.04 the host setting in [Host requirements](#host-requirements). Use current patch releases of [Docker Engine](https://docs.docker.com/engine/install/) and [Compose](https://docs.docker.com/compose/install/).

1. **Start the hub.** It creates its owner from these settings on its first start and serves the API and the dashboard at `http://localhost:8787`. To create the owner in the dashboard instead, leave `ADMIN_EMAIL` and `ADMIN_PASSWORD` out: `docker compose logs hub` then shows a setup link, and step 2 uses the email and password you choose there. For an existing installation, follow [Upgrading the Compose hub](#upgrading-the-compose-hub). Continue to step 2 only after the command succeeds in its new private directory. If the hub fails to start, `docker compose logs hub` shows why.

   <!-- x-release-please-start-version -->

   ```sh
   HUB=http://localhost:8787
   mkdir -m 700 elflodge && cd elflodge && (
     set -e
     umask 077
     curl -fsSLO \
       https://raw.githubusercontent.com/elflodge/elflodge/v0.10.0/compose.yaml
     auth_secret=$(openssl rand -base64 32)
     db_password=$(openssl rand -hex 24)
     printf 'BETTER_AUTH_SECRET=%s\n' "$auth_secret" > .env
     printf 'POSTGRES_PASSWORD=%s\n' "$db_password" >> .env
     cat >> .env <<'EOF'
   ADMIN_EMAIL=you@example.com
   ADMIN_PASSWORD='choose-a-password'
   EOF
     docker compose up --wait hub
   )
   ```

   <!-- x-release-please-end -->

2. **Create keys.** Creating API keys takes a signed-in member, and the command cannot sign in yet, so this step uses `curl`. Each key comes back once, as `key`: the one Runners register with goes into `.env`, and the one for jobs into `ELFLODGE_API_KEY`.

   ```sh
   curl -sS --fail-with-body -c cookies -H 'content-type: application/json' \
     -d '{"email":"you@example.com","password":"choose-a-password"}' "$HUB/api/auth/sign-in/email"
   # The key Runners register with, kept in .env for the Runner
   key=$(curl -sS --fail-with-body -b cookies -H 'content-type: application/json' \
     -d '{"name":"runners","expiresIn":86400,"permissions":{"runner":["register"]}}' "$HUB/api-keys" | jq -er .key) &&
     printf 'RUNNER_REGISTRATION_KEY=%s\n' "$key" >> .env
   # A key for submitting and controlling jobs, for the command
   ELFLODGE_API_KEY=$(curl -sS --fail-with-body -b cookies -H 'content-type: application/json' \
     -d '{"name":"jobs","permissions":{"job":["create","read","pause","resume","cancel","delete"]}}' "$HUB/api-keys" | jq -er .key) &&
     export ELFLODGE_API_KEY
   ```

3. **Start a Runner** with the model every job runs on and its provider's key; it registers with the key step 2 put in `.env`. In Bash or zsh, run `read -rs MY_KEY` on its own, paste the OpenRouter key, and press Enter. The shell hides the input and leaves it out of history. The command below saves it in the private `.env` so recreating the Runner keeps it. A variable exported in the shell, such as `OPENROUTER_API_KEY`, takes precedence over the same name in `.env`, so unset it before running Compose, including for upgrades.

   ```sh
   (
     set -e
     : "${MY_KEY:?Set MY_KEY to your OpenRouter key}"
     cat >> .env <<'EOF'
   RUNNER_MODEL_PROVIDER=openrouter
   RUNNER_MODEL_ID=openrouter/free
   EOF
     printf 'OPENROUTER_API_KEY=%s\n' "$MY_KEY" >> .env
     docker compose up --wait runner
   )
   ```

   Another model goes in `RUNNER_MODEL_ID` the same way, such as `anthropic/claude-haiku-5.5` or `openai/gpt-6-luna` for real work.

   Jobs read web pages and PDFs with pi-web-access, from the image's folder of extensions. Web search is off, except through a ChatGPT subscription the model runs on. To let jobs search through a provider, set `RUNNER_WEB_SEARCH`, such as `brave`, as the comment in `compose.yaml` shows, and add its key. To change the extensions, copy that folder out of the image you run with `docker compose cp runner:/app/extensions ./extensions`, edit the copy, mount it with `./extensions:/extensions:ro` in the runner's `volumes` and set `RUNNER_EXTENSIONS_DIR: /extensions`. When you upgrade the image, compare your own settings files, if any, with its defaults, and copy its folder to a new path, such as `./extensions-0.9.0`, and carry your edits over: its lockfile may pin newer extensions, and `docker compose cp` into an existing folder nests the copy inside it. The Runner's README covers [extensions](../apps/runner/README.md#extensions).

4. **Submit jobs** as in [the README's first job](../README.md#an-everyday-chore-done-by-an-agent), from writing `job.json` on, with `export ELFLODGE_URL=http://localhost:8787`; `docker compose logs runner` shows any error that keeps the Runner from connecting.

### Upgrading the Compose hub

Allow a window for the hub to restart and migrate its database. Rerun only the `curl` line in step 1 from the new release's guide to get its Compose file. If you pin the image tags with `ELFLODGE_VERSION` in your shell or Compose `.env`, update it to the target version or unset it to use the file's tags. Do the same with the previous release's file if you go back. Run `docker compose pull hub` now so a failed image download leaves the old hub serving.

For a predictable window, stop new submissions, pause Batches to block their queued jobs from placement, and let jobs already on Runners finish reporting. If the release changes the Runner protocol incompatibly, drain the Runners this way before upgrading the hub.

Stop the hub, leave Postgres running, and back up the database to a new file. With the hub stopped, it cannot accept writes after the backup.

```sh
docker compose stop hub && docker compose exec -T database pg_dump -U elflodge -Fc elflodge > elflodge-pre-upgrade.dump
```

Wait for the backup command to succeed before starting the new release. Going back after migration requires this backup and the previous hub release.

Use [Docker Compose `up`](https://docs.docker.com/reference/cli/docker/compose/up/) to start just the new hub and wait for it to become healthy. It migrates before it listens.

```sh
docker compose up --wait --no-deps hub
```

Runners that speak the new hub's protocol keep working and reconnect by themselves to report what finished. Targeting just the hub leaves a busy local Runner running. After a restart the Runner recovers its jobs from their journals, but a tool call cut off by the stop is reported as `interrupted`.

If a command fails during the window, retry reads and calls that are safe to repeat once the hub is healthy. Retry a submission with the same IDs. For other writes, first check whether the hub committed the change before the connection closed. For example, repeating a request to create an API key can create a second key.

Once the local Runner's jobs have finished, upgrade it with `docker compose up --wait --no-deps runner`. Upgrade [Runners on other machines](#start-a-runner-on-another-machine) to the same release, then resume any Batches you paused. Upgrade the hub first because a pre-1.0 release may change the Runner protocol and a Runner newer than its hub is unsupported, just as [Kubernetes requires the kubelet to be no newer than its API server](https://kubernetes.io/releases/version-skew-policy/#kubelet).

## Upgrading on a rolling platform

Stop the old hub, take a restorable Postgres backup, then start the new release. On Kubernetes, scale the hub Deployment to zero and wait for its Pod to terminate before the backup. Set the new image while scaled to zero, then scale back to one. A [`Recreate` rollout](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#recreate-deployment) starts the new Pod as soon as the old one stops, so it leaves no pause for the backup.

## Upgrading a hub on Cloudflare Workers

Before migrating, carry your deployed Hyperdrive binding and other edits in `wrangler.jsonc` over to the new release's `apps/hub/wrangler.jsonc`. Check the deployment from that directory first, because a failed deploy after setup leaves the old Worker on the new schema.

1. Run `vp exec wrangler whoami` and confirm you are signed in to the account that runs the hub.
2. Take the ID of the `HYPERDRIVE` binding from the new configuration and run `vp exec wrangler hyperdrive get <id>`. Confirm it points to the hub's Postgres database with caching disabled, as in [the hub's Workers setup](../apps/hub/README.md).
3. Compare the names from `vp exec wrangler secret list` with `secrets.required` in the new configuration. Set any missing secret with `vp exec wrangler secret put <name>` before setup. Wrangler checks that the Worker can inherit those secrets at upload, which a dry run skips.
4. Run `vp run deploy --dry-run` to build the dashboard assets and check that Wrangler can bundle the Worker with them.

Back up the hub's Postgres database. With `DATABASE_URL` pointing directly to that database, run setup and deploy as soon as it succeeds:

```sh
vp run setup && vp run deploy
```

The old Worker serves on the new schema from the migration until the deployment has spread. Creating a Batch can return HTTP 500, and Runner reports can fail. Those errors clear as the new code takes over. Runners reconnect and resend outstanding reports. To go back, restore the database backup together with the old Worker version. Restoring the backup loses writes accepted after it was taken.

Runner reports reach a Durable Object. By default an active object can keep running old code until it hibernates or its five-minute delay expires. Wrangler's `durable_objects.code_update_strategy` setting and its per-deploy `--durable-objects-code-update-mode` flag control [when Durable Objects adopt new code](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/). In `deferred` mode, `max_delay` sets the maximum wait for hibernation in seconds. In `immediate` mode the active object resets onto the new code without waiting to hibernate.

## Runners on other machines

A Runner on another machine connects out to the hub at `HUB_URL`, and callers there use the same URL as `ELFLODGE_URL`. The hub speaks plain HTTP, so across a network members' passwords, session cookies and API keys would cross unencrypted. Reach it in one of three ways.

**A platform's HTTPS.** Where the hub runs on Cloudflare Workers, Railway, Fly.io, Render or Kubernetes behind an ingress, or behind a Cloudflare Tunnel, the platform serves HTTPS: set `HUB_URL` to the `https://` address it gives. Behind a platform's proxy, the hub may need to be told where to find the client's address for its rate limits, with `CLIENT_IP_HEADER` or `TRUSTED_PROXIES` ([the hub's settings](../apps/hub/README.md#settings)); in Compose, set them under the hub's `environment` in `compose.override.yaml`.

**Caddy, for the Compose deployment on a VPS or a machine of your own.** Caddy gets and renews a certificate by itself. Point a domain at this machine, open TCP ports 80 and 443 and UDP port 443, the last for HTTP/3, and add Caddy beside the hub in `compose.override.yaml`, which Compose merges into `compose.yaml`:

```yaml
services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    # For HTTP/3's larger UDP buffers, as Caddy's image documents.
    cap_add:
      - NET_ADMIN
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./caddy:/etc/caddy:ro
      - caddy-data:/data
      - caddy-config:/config
volumes:
  caddy-data:
  caddy-config:
```

Put the `Caddyfile`, naming your domain, in a folder `caddy` beside it; Caddy's image documentation mounts the folder rather than the file, so that an edited file reaches the container:

```
hub.example.com {
	reverse_proxy hub:8787
}
```

Then set `HUB_URL=https://hub.example.com` in `.env` and run `docker compose up -d`. Leave `HUB_PUBLISH` unset, so the hub's plain HTTP port stays closed to other machines. After editing the `Caddyfile`, `docker compose exec -w /etc/caddy caddy caddy reload` applies it.

**A private network.** Tailscale and WireGuard encrypt traffic between their machines, so plain HTTP is safe there. Set `HUB_PUBLISH` in `.env` to this machine's address on that network, such as `100.101.102.103:8787`, and `HUB_URL` to `http://100.101.102.103:8787`, then run `docker compose up -d`. The address must exist when the hub starts. The hub then no longer answers at `localhost`, so callers on its own machine use that URL too.

### Start a Runner on another machine

The new host needs the hub's URL and must meet the [host requirements](#host-requirements). Create a fresh registration key with **Add Runner** in the dashboard; it expires after one day. Registered Runners keep using their own keys.

In Bash or zsh on that machine, run `read -rs MY_KEY` on its own, paste your OpenRouter key, and press Enter. The shell hides the input and leaves it out of history. The following command saves it in the private `runner.env`.

<!-- Keep the command in step with apps/dashboard/src/components/AddRunner.tsx. -->
<!-- x-release-please-start-version -->

```sh
(
  set -e
  : "${MY_KEY:?Set MY_KEY to your OpenRouter key}"
  mkdir -m 700 elflodge-runner
  cd elflodge-runner
  umask 077
  cat > runner.env <<'EOF'
HUB_URL=https://hub.example.com
RUNNER_MODEL_PROVIDER=openrouter
RUNNER_MODEL_ID=openrouter/free
RUNNER_EXTENSIONS_DIR=/app/extensions
EOF
  printf 'RUNNER_REGISTRATION_KEY=%s\n' >> runner.env \
    '<a registration key>'
  printf 'OPENROUTER_API_KEY=%s\n' "$MY_KEY" >> runner.env
  docker run -d --name elflodge-runner --hostname "$(uname -n)" \
    --security-opt seccomp=unconfined --security-opt systempaths=unconfined \
    --security-opt apparmor=unconfined --memory 8g --restart unless-stopped \
    --volume runner-data:/data --env-file runner.env \
    ghcr.io/elflodge/elflodge-runner:0.10.0
)
```

<!-- x-release-please-end -->

The hub lists the Runner under its host's name, which `--hostname` gives the container in place of its ID. `RUNNER_EXTENSIONS_DIR` gives jobs the image's extensions, as the Compose Runner has; to let them search the web, add `RUNNER_WEB_SEARCH` and its key as in step 3. `docker logs elflodge-runner` shows any error that keeps the Runner from connecting. To upgrade it to the hub's release, run `docker stop elflodge-runner && docker rm elflodge-runner`, then run the `docker run` command from the `elflodge-runner` directory with the new version. The Runner's README explains [the Docker options and running it outside Docker](../apps/runner/README.md#what-a-host-needs).

## Calling the API directly

The hub serves an OpenAPI document of its public calls at `/spec.json`, generated from the contract. Anyone can read it. `GET /setup` needs no credential. `POST /setup` takes the token from the setup link. Other calls take an API key in the `x-api-key` header with the listed permissions, a member's session cookie, or either. Errors are RFC 9457 Problem Details.

- **Waiting for a job:** read it until its status is final, waiting longer between reads, as `elflodge jobs wait` does.
- **Reading events.** Open recent history with `order=desc`, then pass `order=desc&after=<oldest ID shown>` until `hasMore` is false. New events can arrive while you walk back. To follow them, read forward from the newest ID seen, or from 0 if the first page was empty. The CLI call is `elflodge jobs events --id <id> --after <newest event id>`. Advance the cursor after each nonempty page. Read again at once while `hasMore` is true, or after a few seconds otherwise. Stop following when an ascending page has both a final `status` and `hasMore: false`.
- **Controls:** jobs and Batches can be paused, resumed (carrying on where they stopped) and cancelled, and jobs deleted once they have ended. The OpenAPI document describes when each control applies. A refused control says why.
