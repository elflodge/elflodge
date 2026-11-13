# runner

A Node process that connects out to the hub and runs many jobs' agents at once. It runs on its user's Node, from 22.19, so it uses only what Node 22 has. It runs separately from the CLI, which calls the hub over HTTP. After `vp run -t runner#build`, which also builds the extension adapter it loads, `vp run start` starts a Runner from the environment:

- `HUB_URL`: the hub's URL.
- `RUNNER_REGISTRATION_KEY`: an API key granted `runner: ["register"]`, shared by Runners. A Runner uses it on its first start to register and receive a key of its own.
- `RUNNER_MODEL_PROVIDER` and `RUNNER_MODEL_ID`: the model every job runs on, as Pi names it, such as `anthropic` and `claude-sonnet-5-5`. The Runner uses saved provider authentication first, then the environment as Pi reads it (for example `ANTHROPIC_API_KEY`); see below. The Runner refuses to start when Pi does not know the model, finds neither a key nor a sign-in for its provider, or cannot renew the sign-in; in the first two cases it lists the models it has a key or sign-in for. Images among a job's Input files, and PDF pages rendered with `pdftoppm`, reach the model as images, so jobs that need them need a model that accepts images.
- `RUNNER_MODEL_BASE_URL`: call the provider's models at this URL instead of the provider's own, such as a gateway, a local model server or a replay server for tests. Give it in the shape of the provider's base URL, such as `http://127.0.0.1:4000/v1` for OpenAI's `https://api.openai.com/v1`; requests carry the provider's key and the model's own ID. Sign-ins are refused while it is set, so their tokens never reach that server. For OpenRouter, name it in `RUNNER_MODEL_PROVIDER` instead; for Azure OpenAI, set `AZURE_OPENAI_BASE_URL`.
- `RUNNER_THINKING_LEVEL`: how hard the model thinks, one of Pi's levels from `off` to `max`; `medium` by default, as in Pi's coding agent.
- `RUNNER_DATA_DIR`: where the Runner keeps its own key, its jobs' journals and Workspaces, and anything else that must survive restarts; `data` by default.
- `RUNNER_MAX_JOBS`: how many jobs the Runner runs at once; 8 by default.
- `RUNNER_JOB_MEMORY_LIMIT`: how much memory each job's processes may use together, in systemd's notation; `1G` by default. A command that goes over is stopped and the agent is told.
- `RUNNER_JOB_READ_PATHS`: folders jobs may read besides the system's, separated by `:` as in `PATH`, such as where mise, nvm or Homebrew keep the tools jobs should use.
- `RUNNER_RUN_WITHOUT_SANDBOX`: `true` runs jobs without a sandbox where none can start, instead of refusing to start; only for jobs whose inputs you trust.
- `RUNNER_NETWORK`: `open`, the default, lets jobs' commands and pi-web-access's page fetches reach the public internet but not local or private addresses; `none` gives them no network, leaving only search through the providers you name. See [Network](#network).
- `RUNNER_NETWORK_EXCEPTIONS`: local or private address ranges jobs may reach all the same, each on every port, or a single address on one, separated by commas, such as `10.20.0.0/16,192.168.1.10:8080`; none by default. See [Network](#network).
- `RUNNER_EXTENSIONS_DIR`: the folder of the Pi extensions every job runs with; none by default. The image's, `/app/extensions`, which Compose and `elflodge stack` name, has pi-web-access, which reads web pages and searches where allowed. See [Extensions](#extensions).
- `RUNNER_EXTENSION_SETTINGS_DIR`: a folder of your own settings files for those extensions, each used in place of the default of the same name; none by default. See [Extensions](#extensions).
- `RUNNER_WEB_SEARCH`: the providers jobs may search the web through, separated by commas, such as `brave,exa`. Unset, search is off, except through a ChatGPT subscription the model runs on. See [Web search](#web-search).

`vp run start login` saves authentication for `RUNNER_MODEL_PROVIDER` in `auth.json` in `RUNNER_DATA_DIR`, readable only by the Runner's user and out of jobs' reach. It offers Pi's supported methods: a provider API key, entered hidden, or a subscription sign-in. A provider with one method goes straight to it. A subscription sign-in prints a page to open in a browser on any device; on a host without a browser, paste back the final address even if its `127.0.0.1` page does not load. Pi renews the sign-in as it expires. A Runner already running uses saved authentication from its next model call.

In the image, run `node dist/main.mjs login` in a temporary container with the Runner's volume, for example:

```sh
docker run --rm -it --volume runner-data:/data --env RUNNER_MODEL_PROVIDER=openai \
  ghcr.io/elflodge/elflodge-runner node dist/main.mjs login
```

For scripts, `login --with-api-key` reads a provider API key from stdin and saves it through the same Pi login flow. Use a pipe without a TTY (`docker run --rm -i` or `docker compose run --rm --no-deps -T`). The key is never a command argument. Empty input and input over 64 KiB fail. This mode supplies one secret only: providers asking for selections or additional fields, such as Bedrock, Vertex and Cloudflare, require interactive login. If a provider asks for more input, the command fails without replacing saved authentication.

Credentials are saved separately for each provider, with one credential per provider; logging in again replaces that provider's credential. `vp run start logout` removes only `RUNNER_MODEL_PROVIDER`'s saved credential, even while the Runner is running. The next model call can then use environment authentication. Logging out does not unset environment variables. A failed OAuth refresh keeps the saved credential and never falls back silently to an environment key; retry after a connection failure or repair the sign-in with login.

`node dist/main.mjs auth-status` reports the provider's configured authentication type and source without printing credential values or refreshing OAuth. Configured does not mean validated: API keys are not tested against a provider, and saved OAuth may need renewal. `node dist/main.mjs auth-check` checks the selected provider/model, the base-URL restrictions and authentication, renewing OAuth when necessary, without connecting to the hub or starting a sandbox. `auth-check --login` offers confirmed interactive login only when authentication is missing and a terminal is available, then checks again. Noninteractive checks fail with login/environment instructions. These commands need the data directory and provider settings; `auth-check` also needs the model ID. Login can save a provider API key while `RUNNER_MODEL_BASE_URL` is set, but cannot save a subscription sign-in for that URL.

A subscription sign-in is one person's: run only that person's own jobs on it, on a host only they control. Each host signs in itself, as a copied `auth.json` would be renewed by two hosts, and the second renewal fails. Whether a provider's terms allow running jobs on its subscription is for the person signing in to check; for OpenAI, see its [Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/).

Once connected, the Runner says hello and syncs with the hub: it offers its free slots, the hub places queued jobs on them, and the Runner reports what becomes of each job. It reports its jobs' new events, usage and activity at the report interval the hub gives it, and at once when a job starts or ends. Once per sync interval it reports every job it holds, or syncs when it holds none to report, and it syncs when the hub hints that it has something new. Each job's agent runs on pi-durable, with a journal, a Workspace and a temp directory of its own: the job's Input files are in its `inputs/` folder, which the Runner downloads from the hub over HTTP, with its own key, before the agent first starts, and the agent ends the job by submitting an output that matches the Output contract. The agent's file operations and commands run in an OS sandbox of the job's own: they read the system's programs and libraries, the folders in `RUNNER_JOB_READ_PATHS`, and the job's Workspace and temp directory, write only the last two, reach the network only as [Network](#network) describes, and have no access to other jobs or the Runner's data, and none of the Runner's environment variables, so not the provider's key. Within its own folders a job may write anything, `.git/hooks` and `.git/config` included, so running git in a job's Workspace outside a sandbox runs what the job wrote there.

Jobs with the same instructions and Output contract share a prompt-cache warm-up on each Runner, even across Batches. The Runner starts one job first and holds the others until its first model call completes or fails, the job ends, or ten seconds pass, counting the first job's own preparation, such as downloading its Input files. Each successful call keeps their shared prefix warm for four minutes, and jobs that arrive meanwhile start at once. This uses the real job's call; it makes no extra model request. Provider caching remains best effort, and each Runner forgets its warmth when it restarts.

A job waiting for this warm-up occupies a Runner slot but has no start event yet. Its run timeout begins only when its agent starts. Pausing or cancelling it while it waits prevents it from starting.

When a Linux host runs out of memory, the kernel kills a job's process rather than the Runner, as jobs' processes start with the highest `oom_score_adj`, unless the Runner itself holds most of the host's memory. The job carries on. Where jobs have a memory limit, a command that ended meanwhile tells the agent whether the host or the job's own limit ran short, and the Runner logs each kill with the job's ID. systemd-oomd, where it runs, stops whole cgroups by rules of its own, which this score does not steer.

A Runner that stops, or is killed outright (by the out-of-memory killer, `kill -9` or a crash), recovers its jobs when it starts again on the same `RUNNER_DATA_DIR`: the hub sends it the jobs still placed on it, and each carries on from its journal where it left off, with its Workspace as it was. A tool call that had completed does not run again. One the stop cut off does not run again either: the job's commands stop with the Runner, and the agent gets pi-durable's `interrupted` result, saying the call may have partly run. A Runner that starts with fewer slots than the jobs placed on it, as after lowering `RUNNER_MAX_JOBS`, recovers as many as it has slots for, and the rest as those end. This covers the Runner's process, not the host: after a power loss or an operating-system crash, a job's last journal commits may be lost. When those commits held only events the hub had not yet received, the job carries on from slightly earlier and may repeat those last seconds of work. A job whose journal is missing, or lacks events the hub already holds, as after its files were deleted or restored from an older backup, is not carried on, which would repeat its work: it fails with `journalLost`, and its files stay for inspection. Resuming it carries on once its journal is restored.

## Extensions

Jobs' agents run with Pi coding-agent extensions, which add tools and react to the agent's work as they do in Pi: those in the folder `RUNNER_EXTENSIONS_DIR` names, and none without it. The image's folder, `/app/extensions`, which Compose and `elflodge stack` name, has [pi-web-access](https://www.npmjs.com/package/pi-web-access), whose `fetch_content` reads web pages and PDFs.

The folder is an ordinary npm project. Its `package.json` lists the extensions as dependencies, its `package-lock.json` pins every package npm installs, and its `.npmrc` sets `legacy-peer-deps=true`, so that npm leaves out the Pi packages extensions declare as peers, which Pi provides, as Pi's own installs do. Its `pi-agent` folder holds the extensions' default settings. To change the extensions, copy the image's folder, from the image of the release you run (`docker compose cp runner:/app/extensions ./extensions`, or `apps/runner/extensions` in the repository at its tag), add an extension there with `npm install <package> --package-lock-only`, then mount the copy and name it, such as `./extensions:/extensions:ro` in the runner's `volumes` and `RUNNER_EXTENSIONS_DIR: /extensions`. A local extension goes inside the folder, as a dependency such as `"my-extension": "file:./my-extension"`.

To change only their settings, keep the image's folder and put your own files in the folder `RUNNER_EXTENSION_SETTINGS_DIR` names, such as `web-search.json` for pi-web-access. The Runner gives the extensions Pi's agent directory made of the defaults, with each of your files, or folders, in place of the default of the same name. Your file is used as written, as in Pi, not merged with the default, except for the network settings the Runner applies to `web-search.json` (see [Web access](#web-access)), so start from a copy of the default (`docker compose cp runner:/app/extensions/pi-agent/web-search.json .`). When you upgrade the image, compare your files with its defaults and carry over what changed.

As it starts, the Runner installs the folder's extensions with `npm ci`, which installs exactly the lockfile's versions and checks each package's hash, in `extensions` in `RUNNER_DATA_DIR`, and bundles them. It refuses to start, naming each extension and why, when the folder has no lockfile or an extension cannot be installed or bundled, and when either folder and `RUNNER_DATA_DIR` contain one another, and when `RUNNER_EXTENSION_SETTINGS_DIR` or `RUNNER_WEB_SEARCH` is set without `RUNNER_EXTENSIONS_DIR`. npm leaves out the folder's devDependencies and runs packages' install scripts. A set is installed once: a Runner restarted with the same folder starts without the registry, and a changed folder, or a Runner on another major Node version, installs afresh, in about 7 s for pi-web-access, and removes the earlier set. Installing needs npm, which the image brings, and the registry. The settings are copied at every start, so the folders are their only source, and what extensions write in their agent directory does not survive a restart. A job fails, naming the extension, before its first model request when one reports an error as it loads, such as calling what the Runner does not support (registering a model provider), and when the extensions' worker exits and they cannot be opened again.

Extensions run in worker threads of the Runner's process, which its jobs share, and are as trusted as the Runner itself: they read its files and environment, provider keys included, and reach the network. Install only extensions you would run as the Runner's user. Commands they run through Pi's `exec` run in the job's sandbox and Workspace, as the agent's own do. Pi's `input` handlers do not run for a job's input.

What extensions spend falls outside a job's model budget: searches cost what their provider charges, and an extension's own model calls are not counted.

### Web search

Jobs search the web through the providers `RUNNER_WEB_SEARCH` names, such as `brave,exa`, with their keys in the Runner's environment, such as `BRAVE_API_KEY`; `elflodge stack start --search brave --env BRAVE_API_KEY` sets both for the stack. The names are pi-web-access's; an unknown one is not caught as the Runner starts, but fails every job as its extensions load, naming it. An empty value is refused. The Runner applies the list to the image's `web-search.json`: it turns the search tools on, allows only those providers, and tries them in that order, moving to the next when one is down, out of quota, unreachable, answers badly or cannot serve the request. A key alone turns nothing on.

Unset, search is off, except when the jobs' model runs on a ChatGPT subscription (provider `openai-codex`): then jobs search through that subscription. It costs nothing per search, uses the subscription's limits, and sends queries to OpenAI, which already answers the jobs. It never reaches an OpenAI key: when the sign-in fails, searches fail rather than fall back to `OPENAI_API_KEY`. Naming `openai` in `RUNNER_WEB_SEARCH` on such a Runner searches through the subscription the same way. The Runner logs what web search does as it starts, and reports it to the hub, which lists it with the Runner (`GET /runners`).

For finer control, give your own `web-search.json` in the settings folder instead; it is used as written, but for the network settings, and the ChatGPT default does not apply. The Runner refuses to start when `RUNNER_WEB_SEARCH` and your own `web-search.json` are both given, or when `RUNNER_WEB_SEARCH` is set but the extensions have no `web-search.json`.

### pi-web-access's defaults

pi-web-access reads its settings from `web-search.json`. The image's defaults spend nothing and send nothing to a service you did not choose, since a key in the Runner's environment is not a choice to use it:

- Web search is off (`tools.webSearch.enabled` and `tools.sourceCheck.enabled` are `false`), which leaves out `web_search` and `source_check`, until `RUNNER_WEB_SEARCH` or the ChatGPT default turns it on. In your own file, name the providers in `webSearch.allowedProviders`: without that list, pi-web-access uses any provider it finds a key for, the Runner's own model provider among them, such as OpenAI, at that account's cost, and keyless ones the model can name, such as Exa's free endpoint and DuckDuckGo, which send a job's queries to services nobody chose.
- Pages are fetched by pi-web-access itself (`fetchRouting.providers: ["http"]`), not by a fetching service. pi-web-access's own defaults already skip its hosted fetchers and use Firecrawl or Crawl4AI only where a server is configured, but the list keeps it so whatever a later version or a configured service would add.
- PDFs are converted locally (`pdf.provider: "unpdf"`), not by Datalab or the Gemini API, which it otherwise tries first when it finds their keys.
- `fetch_content` does not answer questions about a page with a model (`fetch.allowedModes` without `answer`), which would be charged outside the job's budget.
- YouTube analysis and video are off (`youtube.enabled` and `video.enabled`): YouTube analysis uses Gemini, and video reads local files anywhere on the host. A YouTube video's frames and timestamps (`frames`, `timestamp`) follow `image.enabled` instead, and need `yt-dlp` and `ffmpeg` on the host, which the image does not have.

pi-web-access refuses a provider name it does not know, so check `RUNNER_WEB_SEARCH` and your own `web-search.json`, if any, when you change its version.

The Runner refuses a `web_search` call that asks for a summary (`workflow` other than `none`), which pi-web-access writes with a model on the Runner's credentials, outside the job's budget, and one that names the search provider's model (`model`), which the settings choose. A call without `workflow` uses the settings' `workflow`, `none` unless you set another.

The Runner holds pi-web-access to jobs' network, your own `web-search.json` included (see [Web access](#web-access)). The model cannot choose a proxy for pi-web-access's requests: a call that names one, even `""` for a direct request, is refused, so a job cannot route them around jobs' proxy. Tools renamed with `toolNames` lose this check.

## Network

Jobs' commands reach the public internet, so jobs can install packages, call public APIs and fetch what their instructions point to. They cannot reach the Runner's host or the local and private networks around it, where services often answer without a password, unless you open an address for them.

### What jobs can reach

Everything on the public internet. Refused:

- the Runner's host: `localhost`, and every address of its network interfaces;
- loopback, link-local and cloud metadata addresses, such as `127.0.0.1`, `169.254.169.254` and Azure's `168.63.129.16`;
- private networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`) and shared address space (`100.64.0.0/10`);
- the other address ranges that IANA's special-purpose registries mark as not globally reachable, such as documentation, benchmarking and reserved addresses, and multicast and broadcast.

These hold however an address is written, such as `127.1` or `[::ffff:127.0.0.1]`, and for names that resolve to them. A refused request gets a `403` from the proxy, which for an address says what is refused and which setting opens it, and the agent is told in its instructions what is blocked.

A job's own `localhost` is its own: on Linux, a server one of its commands starts is reached by its later commands at `localhost`. On macOS, jobs' commands cannot use loopback at all; for jobs that start servers of their own, run the Runner in Docker.

### Opening addresses

`RUNNER_NETWORK_EXCEPTIONS` opens address ranges to every job of the Runner, separated by commas: `10.20.0.0/16,192.168.1.10:8080`. A range opens every port; a single address can name one port instead, keeping its other ports refused. An IPv6 address takes its port after brackets, `[fd00::5]:8080`. A name alone opens nothing, nor does `0.0.0.0/0`, and an invalid entry stops the Runner from starting.

A loopback, link-local or cloud metadata address opens only when an exception names that address alone, not through a range covering it, so opening `100.64.0.0/10` for Tailscale does not open a cloud's metadata service at `100.100.100.200`. The same goes for multicast, broadcast and unspecified addresses, and for the Runner's own loopback and link-local addresses.

Otherwise a range opens every address it covers, the Runner's own included, so write narrower ranges if you don't mean to open the host. A job reaches a service on the Runner's host as a container would: at one of the host's other addresses, such as Docker's bridge gateway `172.17.0.1` or a LAN address, where the service must listen and an exception must open it. `localhost` through the proxy stays refused.

### Turning the network off

`RUNNER_NETWORK=none` gives jobs' commands no network. Web search still works, through the providers `RUNNER_WEB_SEARCH` names, the ChatGPT default or your own `web-search.json`, with the page text a provider returns beside its results, but `fetch_content` is off and no page is fetched.

### Web access

pi-web-access runs in the Runner's process, outside jobs' sandboxes, so the Runner holds it to the same network: its requests go through the proxy jobs' commands use, and are refused what they are refused. While the network is open, the Runner sets pi-web-access's proxy itself, so a `proxy` or an `ssrf.allowRanges` in your own `web-search.json` stops the Runner from starting; open addresses with `RUNNER_NETWORK_EXCEPTIONS` instead. pi-web-access then sends its requests through `curl`, which the image has and the Runner checks for as it starts.

GitHub cloning and pi-web-access's `gh` lookups of issues and pull requests are off, as `git` and `gh` would reach GitHub past the proxy; GitHub pages are fetched like any other. Gemini Web, if you turn it on, and a YouTube video's frames and timestamps, which run `yt-dlp` and `ffmpeg`, also bypass the proxy. Other extensions reach the network as the Runner does.

To search with SearXNG or Firecrawl you run yourself, make it reachable at the Runner's own `localhost`: run it on the same machine, or, with the Runner in Docker, in a container that shares the Runner's network (`network_mode: service:runner` in Compose), or forward a port to it. This works with either network setting, while jobs still cannot fetch pages there. degoog at `localhost` does not work this way. With the network open, an engine elsewhere can instead be opened with an exception for its address and port, such as `RUNNER_NETWORK_EXCEPTIONS=10.0.0.5:8080`, which also opens that port to jobs' commands.

### Before you rely on it

- Run the Runner on a machine without sensitive services. The refusals go by address, so a way to the host that is not one of its own addresses, such as a cloud instance's public address under 1:1 NAT or a router's port forward, is not refused.
- Behind a proxy of your own, given to the Runner in `HTTP_PROXY` or `HTTPS_PROXY`, jobs' requests go on to that proxy, which resolves names itself, so names are no longer checked against the refused addresses. That proxy must refuse local and private addresses itself. IP addresses are still refused.
- The sandbox enforces these settings, so a Runner that would run jobs without one (`RUNNER_RUN_WITHOUT_SANDBOX=true`) refuses to start with `RUNNER_NETWORK=none` or `RUNNER_NETWORK_EXCEPTIONS` set.

## What a host needs

- **Linux**: `bwrap` (bubblewrap), `socat` and `rg` (ripgrep) on `PATH`, poppler's `pdftotext` and `pdftoppm`, which the agent is told it can use to read PDFs, and `curl`, through which pi-web-access's requests go, for example `sudo apt install bubblewrap socat ripgrep poppler-utils curl`, and util-linux's `choom`, which most distributions install with the system. On Ubuntu 24.04, AppArmor strips the capabilities from the user namespaces that bubblewrap and sandbox-runtime's seccomp helper create, so the host needs `kernel.apparmor_restrict_unprivileged_userns=0` (`sudo sysctl -w`, and a file in `/etc/sysctl.d` to keep it), as sandbox-runtime documents. Ubuntu 25.04 and later also load a profile for bubblewrap, `bwrap-userns-restrict`, that denies capabilities to everything bubblewrap starts, the helper included, so there jobs cannot run in a sandbox until sandbox-runtime no longer needs one ([anthropics/sandbox-runtime#429](https://github.com/anthropics/sandbox-runtime/issues/429)); loading that profile on 24.04 does the same. The memory limit needs a user systemd manager of systemd 254 or later (Ubuntu 24.04, Debian 13): a desktop session has one; on a server, `loginctl enable-linger <user>` keeps one running for the Runner's user. Without it the Runner logs that jobs run without a memory limit.

- **macOS**: poppler's `pdftotext` and `pdftoppm`, for example `brew install poppler`, and `curl`, which macOS has. The sandbox is Seatbelt, which differs from Linux in three ways:
  - Jobs run without a memory limit.
  - A job cannot start a local HTTP server and reach it from another command. macOS gives a job no loopback of its own, and allowing the host's would open every local port of the host to jobs. On Linux, including the Docker image, commands in the same job use their sandbox's own loopback.
  - Bare `mktemp` prefers the Darwin user temp directory, which a job cannot write, so the agent is told to give it a template in `TMPDIR`.
- **Windows**: run the Runner in WSL 2, as on Linux.
- **Docker**: the Runner's image, `ghcr.io/elflodge/elflodge-runner`, runs as a non-root user and needs three options for its jobs' sandboxes, as BuildKit's rootless image does: Docker's defaults deny bubblewrap the namespaces it needs and mask the paths under `/proc` that a sandbox mounts its own over.

  ```sh
  docker run --security-opt seccomp=unconfined --security-opt systempaths=unconfined \
    --security-opt apparmor=unconfined --memory 8g --restart unless-stopped --volume runner-data:/data \
    --env HUB_URL --env RUNNER_REGISTRATION_KEY --env RUNNER_MODEL_PROVIDER --env RUNNER_MODEL_ID \
    --env ANTHROPIC_API_KEY ghcr.io/elflodge/elflodge-runner
  ```

  `apparmor=unconfined` is needed only on hosts with AppArmor; on Ubuntu 24.04 the host also needs `kernel.apparmor_restrict_unprivileged_userns=0` (in `/etc/sysctl.d`), as BuildKit's rootless image does, and on Ubuntu 25.04 and later its jobs cannot run in a sandbox yet, as on the host. `--restart` starts the Runner again after it stops, as when it could not reach the hub on its first start. `RUNNER_DATA_DIR` is `/data` in the image, so keep it on a volume. A container has no user systemd, so jobs run without a memory limit of their own: `--memory` caps the Runner and its jobs together. Jobs' commands find the programs of Debian's slim image; for more, build an image from this one.

The Runner proves the sandbox works when it starts, and refuses to start, naming what is missing, if it does not.

A Runner the hub has removed, or a hub that no longer knows (for example after a reset), stops with a message instead of retrying; `vp run start register` discards its key and registers it again. Any other refusal, such as from a proxy or from a hub that cannot reach its database, is retried.

To remove a compromised host, delete its Runner on the hub (`DELETE /runners/{id}`), then revoke the registration key and create a new one for future hosts: the host still holds the old one and could otherwise register again. Runners already registered keep working, since they connect with their own keys. A registration key can also be created to expire (`expiresIn`), for a key meant for one batch of hosts.
