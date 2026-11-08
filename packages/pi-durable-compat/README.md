# @elflodge/pi-durable-compat

Run Pi coding-agent extensions on pi-durable.

This package isn't part of Pi. It was built for [Elflodge](https://github.com/elflodge/elflodge)'s Runner, which runs many unattended agents in one process, and it is tested with the extensions listed below. pi-durable has no built-in way to run coding-agent extensions yet (earendil-works/pi#10386). When it does, this package will point you to it.

## Usage

```sh
npm install @elflodge/pi-durable-compat @earendil-works/pi-durable @earendil-works/pi-ai @earendil-works/chord
```

Prepare the extensions once when your process starts, then attach them to each conversation before you submit to it:

```ts
import { prepareExtensions, startExtensionHost } from "@elflodge/pi-durable-compat";

const prepared = await prepareExtensions({
  sources: ["npm:pi-web-access@0.47.0"],
  dir: "/var/cache/my-app/pi-extensions",
});
const host = startExtensionHost({ prepared });

const registry = createRegistry();
const harness = await Harness.open(storage, { models, registry }, context);
const conversation = await harness.root(context, { agent: { model } });
const extensions = await host.attach(
  { harness, conversation, registry, models, env, cwd },
  context,
);

const input = await extensions.input(prompt, undefined, context);
if (input.action !== "handled") {
  const content = input.action === "transform" ? input.text : prompt;
  await conversation.submit({ type: "input", content }, context);
}
// When the conversation's work is done:
await extensions.close();
```

`prepareExtensions` installs the sources with Pi's own package manager, as `pi install` does (npm sources need npm), and bundles them with Rolldown into one build that keeps only the parts of Pi's packages they use. The build is cached in `dir` and reused while the sources and their versions stay the same. `failures` lists the sources that could not be installed or bundled; the rest work without them.

`startExtensionHost` runs the extensions in worker threads: none while no conversation is attached, at most `maxWorkers` (default 2), each hosting many conversations. Every conversation gets its own instance of each extension, as every Pi session does. `attach` installs a pi-durable extension in `registry` with the extensions' tools and only the hooks some extension listens to.

## What extensions get

| Pi API                                                                                                                                                     | Here                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `registerTool`, including `prepareArguments`, `executionMode` and `exposure` (`hidden`, `model-only`)                                                      | Registered with pi-durable; calls run in the worker and are cancelled with the call.                      |
| `on("tool_call")`, `on("tool_result")`                                                                                                                     | Run for every tool call, the host's own tools included: block a call, change its arguments or its result. |
| `on("context")`, `on("before_provider_request")`                                                                                                           | Change a request's messages or its provider payload.                                                      |
| `on("input")`                                                                                                                                              | Run by `extensions.input()` on input before you submit it.                                                |
| `on("session_start")`, `on("session_shutdown")`                                                                                                            | On `attach` and `close`.                                                                                  |
| `appendEntry`, `ctx.sessionManager.getBranch()`, `getEntries()`, `getEntry()`, `getLeafId()`                                                               | Saved as custom entries in the conversation's journal and read back from it.                              |
| `sendMessage`, `sendUserMessage`, `ctx.compact()`, `ctx.abort()`                                                                                           | Submitted to the conversation. Dropped after `close`.                                                     |
| `exec`                                                                                                                                                     | Runs in the `env` given to `attach`, not on the host.                                                     |
| `ctx.model`, `ctx.modelRegistry` (`find`, `getAll`, `getAvailable`, `hasConfiguredAuth`, `getApiKeyAndHeaders`, `getProviderAuth`, `getApiKeyForProvider`) | Answered from the `models` given to `attach`.                                                             |
| `events`, `registerFlag`, `getFlag`                                                                                                                        | As in Pi, shared by one conversation's extensions.                                                        |
| Tools and handlers registered after loading                                                                                                                | The conversation's pi-durable extension is installed again with them.                                     |
| Commands, shortcuts, renderers, UI                                                                                                                         | Accepted and unused, as in Pi's print mode: `ctx.hasUI` is false.                                         |

Every other Pi API either does nothing here or throws an error saying it is not supported.

## Tested extensions

- [`pi-web-access`](https://www.npmjs.com/package/pi-web-access) 0.47.0: loads and registers its tools; `fetch_content` fetches pages.
- [`pi-web-search`](https://www.npmjs.com/package/pi-web-search) 1.7.0: loads and registers its tools.

## Limits

- Extensions run in worker threads of your process with its permissions. A worker thread is not a sandbox: `exec` goes through your `env`, but an extension that uses `node:fs` or `node:child_process` itself is not contained. Install only extensions you trust.
- Extensions' modules load once per worker and are shared by its conversations. State an extension keeps in its factory is per conversation; state at module level is per worker.
- An extension that does not bundle is not loaded; loading it as Pi does would need Pi's TypeScript loader and its whole coding agent in every worker.
- When a worker exits, its conversations' extension tools fail from then on.
- Tool calls are recorded as unsafe to replay: after a crash, pi-durable does not run an interrupted extension tool again.
