# Deploying Elflodge

The README starts one machine with `npx elflodge stack start`. This page has what running it for longer needs: host requirements, operating the local stack, a Compose deployment, opening the hub to Runners and callers on other machines, and how to call the hub's API directly.

## Host requirements

Docker Engine 29 or later with Compose 5 or later, Node 22.19 or later, and `jq` for the README's examples. Use current patch releases of [Docker Engine](https://docs.docker.com/engine/install/) and [Compose](https://docs.docker.com/compose/install/).

On Ubuntu 24.04, let the Runner's job sandboxes create user namespaces before starting it: `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, plus a file in `/etc/sysctl.d` to keep the setting across reboots. On Ubuntu 25.04 and later, jobs cannot run in a sandbox yet. [The Runner's README](../apps/runner/README.md) explains both, and covers running a Runner outside Docker.

## One machine: the local stack

`npx elflodge stack start` runs a hub, its Postgres and a Runner from the images released with the CLI, in the background, and keeps running after the terminal closes. It returns once the hub is healthy and the Runner has started. On its first start it creates the hub's owner and an API key for jobs; `elflodge` commands use that hub and key while `ELFLODGE_URL` and `ELFLODGE_API_KEY` are unset, and `npx elflodge stack env` prints both for other clients, such as `curl`.

- **Models.** The default is OpenRouter's free models. Choose another with `--provider` and `--model`, as Pi names them, such as `--provider anthropic --model claude-sonnet-5-5`. On first use the command offers provider login and saves it in the Runner's volume; keys are hidden as you type. `npx elflodge stack login --provider <provider>` adds or replaces one provider's credential, offering an API key or account sign-in where Pi supports them; `--with-api-key` reads a key from stdin. To supply a key from your environment instead, forward its variable by name: `OPENROUTER_API_KEY="$MY_KEY" npx elflodge stack start --env OPENROUTER_API_KEY`, where `MY_KEY` already holds the key, so it stays out of your shell history.
- **Web access.** Jobs' agents read web pages and PDFs with pi-web-access. Web search is off, except through a ChatGPT subscription the model runs on. To let jobs search through a provider, name it and forward its key: `BRAVE_API_KEY="$MY_BRAVE_KEY" npx elflodge stack start --search brave --env BRAVE_API_KEY`. A forwarded key alone does not turn search on, and `--reset-search` goes back to the default. The Runner's README covers [extensions](../apps/runner/README.md#extensions).
- **Status and logs.** `npx elflodge stack status` shows whether the stack is running, the hub's URL and health, the image versions in use and the Runner's authentication source. `npx elflodge stack logs` prints the logs; `--follow` keeps printing them. A job stays `queued` until a Runner has room for it, and the Runner's log shows any error that keeps it from connecting.
- **Stopping.** `npx elflodge stack stop` keeps the containers, data and credentials for the next start. `npx elflodge stack delete` removes the database and Runner volumes, including saved logins, without a prompt.
- **Upgrading.** Let the local Runner's jobs finish first. `npx elflodge stack stop` stops that Runner along with the hub and Postgres. Back up the stopped volumes, then run `npx elflodge@<new-version> stack start` with the new CLI version. It starts Postgres on the existing volume, waits for the new hub to migrate the database and become healthy, then brings up the matching Runner with its saved data and logins. If you forwarded variables with `--env`, have their values in your environment again. To go back, restore the pre-upgrade volumes and start with the previous CLI version.

## Several machines: Docker Compose

The hub and a Runner from their published images on one machine, as a deployment that other machines' Runners and callers can reach once the hub is opened to them, as [Runners on other machines](#runners-on-other-machines) shows. It needs Docker Engine 29 or later and Compose 5 or later, `curl`, `jq` and `openssl`, and on Ubuntu 24.04 the host setting in [Host requirements](#host-requirements). Use current patch releases of [Docker Engine](https://docs.docker.com/engine/install/) and [Compose](https://docs.docker.com/compose/install/).

1. **Start the hub.** It creates its owner from these settings on its first start and serves the API and the dashboard at `http://localhost:8787`. To create the owner in the dashboard instead, leave `ADMIN_EMAIL` and `ADMIN_PASSWORD` out: `docker compose logs hub` then shows a setup link, and step 2 uses the email and password you choose there. For an existing installation, follow [Upgrading the Compose hub](#upgrading-the-compose-hub).

   <!-- x-release-please-start-version -->

   ```sh
   curl -fsSLO https://raw.githubusercontent.com/elflodge/elflodge/v0.10.0/compose.yaml
   cat > .env <<EOF
   BETTER_AUTH_SECRET=$(openssl rand -base64 32)
   POSTGRES_PASSWORD=$(openssl rand -hex 24)
   ADMIN_EMAIL=you@example.com
   ADMIN_PASSWORD=choose-a-password
   EOF
   # Returns once the hub has migrated its database and created its owner from these settings; if the hub itself fails, `docker compose logs hub` says why
   docker compose up --wait hub
   HUB=http://localhost:8787
   ```

   <!-- x-release-please-end -->

2. **Create keys.** Creating API keys takes a signed-in member, and the command cannot sign in yet, so this step uses `curl`. Each key comes back once, as `key`: the one Runners register with goes into `.env`, and the one for jobs into `ELFLODGE_API_KEY`.

   ```sh
   curl -sS --fail-with-body -c cookies -H 'content-type: application/json' \
     -d '{"email":"you@example.com","password":"choose-a-password"}' "$HUB/api/auth/sign-in/email"
   # The key Runners register with, kept in .env for the Runner
   key=$(curl -sS --fail-with-body -b cookies -H 'content-type: application/json' \
     -d '{"name":"runners","permissions":{"runner":["register"]}}' "$HUB/api-keys" | jq -er .key) &&
     echo "RUNNER_REGISTRATION_KEY=$key" >> .env
   # A key for submitting and controlling jobs, for the command
   ELFLODGE_API_KEY=$(curl -sS --fail-with-body -b cookies -H 'content-type: application/json' \
     -d '{"name":"jobs","permissions":{"job":["create","read","pause","resume","cancel","delete"]}}' "$HUB/api-keys" | jq -er .key) &&
     export ELFLODGE_API_KEY
   ```

3. **Start a Runner** with the model every job runs on and its provider's key; it registers with the key step 2 put in `.env`:

   ```sh
   cat >> .env <<EOF
   RUNNER_MODEL_PROVIDER=openrouter
   RUNNER_MODEL_ID=openrouter/free
   OPENROUTER_API_KEY=<your key>
   EOF
   docker compose up --wait runner
   ```

   Another model goes in `RUNNER_MODEL_ID` the same way, such as `anthropic/claude-haiku-5.5` or `openai/gpt-6-luna` for real work.

   Jobs read web pages and PDFs with pi-web-access, from the image's folder of extensions. Web search is off, except through a ChatGPT subscription the model runs on. To let jobs search through a provider, set `RUNNER_WEB_SEARCH`, such as `brave`, as the comment in `compose.yaml` shows, and add its key. To change the extensions, copy that folder out of the image you run with `docker compose cp runner:/app/extensions ./extensions`, edit the copy, mount it with `./extensions:/extensions:ro` in the runner's `volumes` and set `RUNNER_EXTENSIONS_DIR: /extensions`. When you upgrade the image, compare your own settings files, if any, with its defaults, and copy its folder to a new path, such as `./extensions-0.9.0`, and carry your edits over: its lockfile may pin newer extensions, and `docker compose cp` into an existing folder nests the copy inside it. The Runner's README covers [extensions](../apps/runner/README.md#extensions).

4. **Submit jobs** as in [the README's first job](../README.md#an-everyday-chore-done-by-an-agent), from writing `job.json` on, with `export ELFLODGE_URL=http://localhost:8787`; `docker compose logs runner` shows any error that keeps the Runner from connecting.

### Upgrading the Compose hub

Allow a window for the hub to restart and migrate its database. For a predictable window, stop new submissions, pause Batches to hold queued jobs, and let jobs already on Runners finish reporting. Take a Postgres backup before upgrading. Going back after migration requires both this backup and the previous hub release.

Rerun only the `curl` line in step 1 from the new release's guide to get its Compose file. With Postgres running, upgrade just the hub:

```sh
docker compose up --wait --no-deps hub
```

Compose stops the old hub before starting its replacement. The new hub migrates before it listens. A command in flight can fail during that window. Run it again once the hub is healthy, using the same IDs when retrying a submission. Runners keep working through the outage and reconnect by themselves to report what finished. Targeting the hub leaves a busy local Runner running. [Docker Compose `up`](https://docs.docker.com/reference/cli/docker/compose/up/)

Once the local Runner's jobs have finished, upgrade it with `docker compose up --wait --no-deps runner`. Upgrade [Runners on other machines](#start-a-runner-on-another-machine) to the same release, then resume any Batches you paused. Upgrade the hub first because a pre-1.0 release may change the Runner protocol and a Runner newer than its hub is unsupported.

On platforms that roll out containers, choose a replacement deployment for the single hub process. Stop the old hub before the new one starts its migrations.

## Upgrading a hub on Cloudflare Workers

Back up the hub's Postgres database. From the new release's `apps/hub` directory, with `DATABASE_URL` pointing directly to that database, run setup and deploy as soon as it succeeds:

```sh
vp run setup && vp run deploy
```

The old Worker serves on the new schema from the migration until the deployment has spread. Creating a Batch can return HTTP 500, and Runner reports can fail. Those errors clear as the new code takes over. Runners reconnect and resend outstanding reports. To go back, restore the database backup together with the old Worker version.

Runner reports reach a Durable Object. By default an active object can keep running old code until it hibernates or its five-minute delay expires. Wrangler's `durable_objects.code_update_strategy` can shorten that part of the window. In `deferred` mode, `max_delay` sets the maximum wait for hibernation in seconds. In `immediate` mode the active object resets onto the new code without waiting to hibernate. [Cloudflare's Durable Object code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/)

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

A Runner needs the hub's URL and a registration key, such as the one step 2 of the Compose deployment puts in `.env`, and the other machine needs the same [host requirements](#host-requirements). With Docker:

<!-- x-release-please-start-version -->

```sh
cat > runner.env <<EOF
HUB_URL=https://hub.example.com
RUNNER_REGISTRATION_KEY=<a registration key>
RUNNER_MODEL_PROVIDER=openrouter
RUNNER_MODEL_ID=openrouter/free
OPENROUTER_API_KEY=<your key>
RUNNER_EXTENSIONS_DIR=/app/extensions
EOF
docker run -d --name elflodge-runner --hostname "$(uname -n)" --security-opt seccomp=unconfined \
  --security-opt systempaths=unconfined --security-opt apparmor=unconfined --memory 8g \
  --restart unless-stopped --volume runner-data:/data --env-file runner.env \
  ghcr.io/elflodge/elflodge-runner:0.10.0
```

<!-- x-release-please-end -->

The hub lists the Runner under its host's name, which `--hostname` gives the container in place of its ID. `RUNNER_EXTENSIONS_DIR` gives jobs the image's extensions, as the Compose Runner has; to let them search the web, add `RUNNER_WEB_SEARCH` and its key as in step 3. `docker logs elflodge-runner` shows any error that keeps the Runner from connecting. To upgrade it to the hub's release, run `docker stop elflodge-runner && docker rm elflodge-runner`, then the `docker run` line with the new version. The Runner's README explains [the Docker options and running it outside Docker](../apps/runner/README.md#what-a-host-needs).

## Calling the API directly

The hub serves an OpenAPI document of its public calls at `/spec.json`, generated from the contract. Anyone can read it. `GET /setup` needs no credential. `POST /setup` takes the token from the setup link. Other calls take an API key in the `x-api-key` header with the listed permissions, a member's session cookie, or either. Errors are RFC 9457 Problem Details.

- **Waiting for a job:** read it until its status is final, waiting longer between reads, as `elflodge jobs wait` does.
- **Reading events:** a job's events come a page at a time. Read again `after` the last event's `id` while `hasMore` is true, and stop once a page without more has a final `status`. `elflodge jobs events --id <id> --after <event id>` does the same from the command line.
- **Controls:** jobs and Batches can be paused, resumed (carrying on where they stopped) and cancelled, and jobs deleted once they have ended. The OpenAPI document describes when each control applies. A refused control says why.
