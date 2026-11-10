# @elflodge/pi-durable-extension-adapter

Use Pi's coding-agent extensions in apps built on pi-durable.

[Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) has a large collection of third-party extensions: npm packages that give the agent tools such as web search, react to its events and keep state in its session. [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable), Pi's library for agents whose conversations survive a restart, has an extension format of its own and cannot load them ([earendil-works/pi#10386](https://github.com/earendil-works/pi/issues/10386)). An app built on pi-durable therefore starts without the tools Pi users already have.

This package loads those extensions, unchanged, into pi-durable conversations. You name them as you would for `pi install`, attach them to a conversation, and the model can call their tools while their handlers see the conversation's events.

It was built for [Elflodge](https://elflodge.com), which runs hundreds of Pi agents unattended and in parallel on your own machine, each returning results checked against your schema. You don't need Elflodge to use it: it works in any app built on pi-durable. There is [more about Elflodge](#elflodge) at the end.

## What you get

- Extensions install from the same sources as `pi install` takes: an npm package, a git repository or a local path. Pi's own package manager installs them.
- Extensions run on Pi's own code. Pi's loader and runner load them and call their handlers, so the order of handlers, the way their results combine and the way one failing handler is kept from the others are Pi's. Where pi-durable works differently from Pi's coding agent, the [table below](#what-extensions-get) says what an extension sees.
- What extensions save is as durable as the conversation. Entries from `appendEntry` and the messages extensions send are written to the conversation's journal, so an extension finds its state again after a restart.
- Many conversations share a few worker threads. Each conversation gets its own instance of every extension, as each Pi session does, while the extensions' code loads once per worker, bundled with only the parts of Pi it uses.
- Your app stays responsive. Extensions run in worker threads, so an extension's heavy synchronous work, such as parsing a large page, does not stall pi-durable or your own code.
- Your app survives an extension that crashes. An uncaught error, `process.exit()` or a full heap ends only the worker it happened in, and the conversations on that worker get their extensions back on another one.
- An extension that hangs while it opens or closes cannot stall a conversation's start or end: each has a time limit of 10 s.

Two extensions are tested today, listed under [Tested extensions](#tested-extensions). Where Pi's extension API has no counterpart in pi-durable, or a kind of extension is not supported, the [table of Pi APIs](#what-extensions-get) and the [limits](#limits) say so.

## Quick start

Add it to an app set up as [pi-durable's README](https://www.npmjs.com/package/@earendil-works/pi-durable) shows, on Node 22.19 or later:

```sh
npm install @elflodge/pi-durable-extension-adapter
```

It uses your app's pi-durable packages, 1.5.1 or later. Extensions from npm sources also need `npm` on the machine.

Prepare the extensions once when your process starts, then attach them to each conversation before you submit to it:

```ts
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { prepareExtensions, startExtensionHost } from "@elflodge/pi-durable-extension-adapter";

// Once, when the process starts.
const prepared = await prepareExtensions({
  sources: ["npm:pi-web-access@0.47.0"],
  dir: "/var/cache/my-app/pi-extensions",
});
for (const { source, message } of prepared.failures) console.error(`${source}: ${message}`);
const host = startExtensionHost({ prepared });

// Your pi-durable setup, with the registry kept in a variable.
const registry = createRegistry();
const harness = await Harness.open(storage, { models, registry }, context);
const conversation = await harness.root(context, { agent: { model } });

// For each conversation, before you submit to it.
const extensions = await host.attach(
  { harness, conversation, registry, models, env, cwd },
  context,
);

// Extensions see a prompt before the model does, as in Pi.
const input = await extensions.input(prompt);
if (input.action !== "handled") {
  const content = input.action === "transform" ? input.text : prompt;
  const submission = await conversation.submit({ type: "input", content }, context);
  await submission.wait(context);
}

await extensions.close(); // when the conversation's work is done
await host.close(); // when the process shuts down
```

`storage`, `models`, `model` and `context` are what you already pass to pi-durable. `env` is a pi-durable `ExecutionEnv`, such as `NodeExecutionEnv`, in which `pi.exec` runs commands; without one, `pi.exec` throws.

Check what did not load. `prepared.failures` lists the sources that could not be installed or bundled, and `extensions.errors` lists the extensions that failed to load for this conversation; in both cases the others work without them.

`extensions.input()` runs the extensions' `input` handlers, which can leave the prompt as it is (`continue`), replace its text and images (`transform`), or answer it themselves (`handled`), in which case you submit nothing.

An attached conversation keeps your process alive until you close its extensions or the host. `host.close()` closes the extensions of every attached conversation and stops the workers.

After a restart, attach again to the conversations you reopen. Their extensions then start with `session_start` reason `resume` and read the entries they saved before.

## Using it

### Preparing extensions

Pin the versions of npm sources. An unpinned source installs whatever version is latest at the time.

Give `dir` a directory that is kept between starts and used by one process at a time. Pi reuses the packages installed there while the sources stay the same. The entry of each extension installed in `dir` is written beside its source, as `<name>.pi-durable-extension-adapter.mjs`; everything else that is built goes in `dir/bundle`.

Call `prepareExtensions` once per process. It builds the bundle again on every call, which takes about a second, so a second call would rebuild the bundle that a running host's workers load. It runs in a child process, which takes several hundred MiB for a few extensions and gives them back when it exits.

The packages Pi supplies to extensions (`pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui` and TypeBox) come from this package's own copy of the coding agent, so every extension runs on the Pi version this package was tested with. That copy is pinned to one minor line of Pi. If a Pi patch release has moved a file the build relies on, preparing fails and names the file.

### Errors and time limits

A handler that throws does not end the conversation, as in Pi. The error is passed to `onError` with the extension, the event and the error's message and stack.

Opening and closing have a time limit of 10 s each. `attach` waits for the extensions to load and for their `session_start` handlers; past the limit it fails. `close` waits for their `session_shutdown` handlers; past the limit it returns, and what the handlers do later is dropped. Tool calls and other handlers have no time limit.

### When a worker exits

A worker exits when an extension throws an uncaught error, calls `process.exit()` or runs past the worker's heap limit. The tool calls running in it fail with the reason. The host then opens the extensions of that worker's conversations again on another worker, with `session_start` reason `resume`, as after a restart. What they kept in memory is lost, and the other conversations on that worker restart with them.

A conversation is lost when its extensions fail to open again, or when `restart` is false. It goes on without its extensions: their tools fail and their handlers no longer run. If its extensions handle `tool_call`, all its tool calls are blocked, as Pi blocks a call when a `tool_call` handler fails, because the host cannot tell a handler that guards calls from one that only observes them.

To act on an exit yourself, for instance to fail the job, pass `onWorkerExit`: it receives the error and the IDs of the conversations that were opened again and of those that were lost.

### Registries and subagents

The first `attach` through a registry installs one pi-durable extension in it, named `pi-durable-extension-adapter`, which carries the tools and hooks of every conversation attached through that registry.

A registry serves one Harness and one host, and a conversation can be attached once at a time. `attach` throws otherwise.

The conversations of a registry are offered each tool as the first of them to register it described it. A call fails in a conversation whose own extensions did not register the tool, or registered it as hidden. Flags that change which tools an extension registers therefore need a registry for each group of conversations that share them.

pi-durable selects every installed extension for every conversation unless told otherwise. A conversation you did not attach, such as a subagent's, is offered the tools too, and its calls to them fail. Either attach it, or leave the extension out of its selection with pi-durable's `extensions` setting, here for a conversation `child` that is not attached:

```ts
await child.configure(
  { extensions: { remove: [{ name: "pi-durable-extension-adapter" }] } },
  context,
);
```

## Options

### `prepareExtensions(options)`

| Option       | Default   | Meaning                                                                                                                                                                  |
| ------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sources`    | required  | The extension packages, as Pi's settings name them: `npm:pi-web-access@0.47.0`, a git URL or a local path.                                                               |
| `dir`        | required  | Where Pi installs the packages and the bundle is built. Kept between starts, for one process at a time.                                                                  |
| `npmCommand` | `["npm"]` | Pi's `npmCommand` setting: the command that runs npm, with its arguments.                                                                                                |
| `signal`     | none      | Aborting it ends the child process and rejects with Node's `AbortError`, the signal's reason as its `cause`. A package manager that has already started runs to its end. |

### `startExtensionHost(options)`

| Option          | Default        | Meaning                                                                                                                                                                                              |
| --------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepared`      | required       | What `prepareExtensions` returned.                                                                                                                                                                   |
| `maxWorkers`    | `2`            | The most worker threads extensions run in. A worker busy with a handler's synchronous work holds up the conversations on it.                                                                         |
| `idleTimeout`   | `30000`        | How long a worker with no conversation stays before it exits, in milliseconds.                                                                                                                       |
| `onError`       | standard error | Called with a handler's error and the conversation's ID when a handler fails after its extension loaded.                                                                                             |
| `workerOptions` | none           | Node's `resourceLimits` and `env` for the workers. `resourceLimits` caps a worker's JavaScript heap, not memory outside it, such as buffers. `env` is their `process.env`, by default the process's. |
| `restart`       | `true`         | Whether the extensions of an exited worker's conversations are opened again on another worker.                                                                                                       |
| `onWorkerExit`  | standard error | Called when a worker exits with conversations attached, with the error and the conversations `reopened` and `lost`.                                                                                  |

### `host.attach(options, context)`

| Option         | Default  | Meaning                                                                                                          |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `harness`      | required | The Harness the conversation belongs to.                                                                         |
| `conversation` | required | The conversation the extensions act for.                                                                         |
| `registry`     | required | The registry the Harness was opened with.                                                                        |
| `models`       | required | The models the Harness was opened with. Extensions read them, switch between them and get credentials from them. |
| `cwd`          | required | The directory extensions see as `ctx.cwd`.                                                                       |
| `env`          | none     | The environment `pi.exec` runs commands in. Without one, `pi.exec` throws.                                       |
| `flags`        | none     | Values for the flags extensions register with `pi.registerFlag`, by name.                                        |

It resolves to the conversation's extensions: `errors`, `input(text, options)` and `close()`. The options of `input` are the prompt's `images`, its `source` (default `rpc`, as Pi's RPC mode reports a client's prompt) and its `streamingBehavior`, as Pi's `prompt` takes them.

## What extensions get

| Pi API                                                                                                                                                                                                                                                                            | Here                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registerTool`, including `prepareArguments`, `executionMode`, `exposure`, `defaultActive`, `promptSnippet` and `promptGuidelines`                                                                                                                                                | Calls run in the worker and are cancelled with the call. Tools Pi does not activate when they are registered are deferred. While a tool is offered, its `promptSnippet` and `promptGuidelines` are in the system prompt, as Pi lists an active tool's. Partial results a tool reports while it runs are discarded. pi-durable validates a call's arguments before the tool's `prepareArguments` runs; the host first parses arrays and objects sent as JSON text, but a `prepareArguments` that renames fields or fills in required ones does not get to fix arguments that fail validation. |
| `on("tool_call")`, `on("tool_result")`                                                                                                                                                                                                                                            | Run for every tool call, the host's own tools included: block a call, change its arguments or its result. `tool_result` also runs for a call pi-durable rejects before it runs, an unknown tool or invalid arguments, which Pi does not.                                                                                                                                                                                                                                                                                                                                                     |
| `on("tool_execution_start")`, `on("tool_execution_end")`                                                                                                                                                                                                                          | Observed for every tool call, the host's own tools and rejected calls included; what handlers return is ignored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `on("context")`, `on("context_with_system")`, `on("before_provider_request")`                                                                                                                                                                                                     | Change a request's messages or its provider payload; messages of Pi's own kinds become model messages as Pi converts them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `on("before_agent_start")`, `on("agent_start")`                                                                                                                                                                                                                                   | Once per run, at its first request. See [Runs](#runs) below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `on("turn_start")`, `on("message_end")`, `on("turn_end")`, `on("agent_end")`                                                                                                                                                                                                      | Observed; what handlers return is ignored. See [Runs](#runs) below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `on("session_before_compact")`                                                                                                                                                                                                                                                    | `cancel` declines the compaction and `compaction.summary` replaces pi-durable's summary; the rest of the result is ignored. `preparation` carries the messages to summarize and the first kept entry's ID.                                                                                                                                                                                                                                                                                                                                                                                   |
| `on("input")`                                                                                                                                                                                                                                                                     | Run by `extensions.input()` on input before you submit it; handlers are told its `streamingBehavior` only while a run is under way. An extension's `sendUserMessage` goes through them too, with source `extension`.                                                                                                                                                                                                                                                                                                                                                                         |
| `on("session_start")`, `on("session_shutdown")`                                                                                                                                                                                                                                   | On `attach`, with reason `resume` if the conversation has entries already, and on `close`, which keeps what the handlers write.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `appendEntry`, `ctx.sessionManager.getBranch()`, `getEntries()`, `getEntry()`, `getLeafId()`                                                                                                                                                                                      | Saved in the conversation's journal and read back from it, also right after a write. An entry's data is stored as JSON: a value `JSON.stringify` rejects, such as a BigInt, throws in the extension's call, and one it leaves out, such as a function, is not saved.                                                                                                                                                                                                                                                                                                                         |
| `sendMessage`, `sendUserMessage`, `ctx.compact()`, `ctx.abort()`                                                                                                                                                                                                                  | Submitted to the conversation, `sendUserMessage` after the `input` handlers. A `sendUserMessage`, or a `sendMessage` with `triggerTurn`, that arrives while the conversation is busy steers the run with `deliverAs: "steer"` and is queued as a follow-up with any other value. A `sendMessage` without `triggerTurn` is written to the conversation and starts nothing. Dropped after `close`.                                                                                                                                                                                             |
| `exec`                                                                                                                                                                                                                                                                            | Runs in the `env` given to `attach`, with Pi's options: `cwd` (default `ctx.cwd`), `timeout`, `signal` and `maxBuffer`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ctx.model`, `ctx.isIdle()`, `setModel`, `getThinkingLevel`, `setThinkingLevel`, `getActiveTools`, `setActiveTools`, `getAllTools`, `ctx.modelRegistry` (`find`, `getAll`, `getAvailable`, `hasConfiguredAuth`, `getApiKeyAndHeaders`, `getProviderAuth`, `getApiKeyForProvider`) | Read from and made to the conversation's agent and the `models` given to `attach`, as in Pi: `setActiveTools` changes the tools offered to the model from the next request, `setModel` switches only to a model with credentials, and `model_select` and `thinking_level_select` follow a switch.                                                                                                                                                                                                                                                                                            |
| `events`, `registerFlag`, `getFlag`                                                                                                                                                                                                                                               | As in Pi, shared by one conversation's extensions. Flag values come from `attach`'s `flags`, as Pi's from its command line; an unknown name or a value of the wrong type is reported in `errors` and not set.                                                                                                                                                                                                                                                                                                                                                                                |
| Tools and handlers registered after loading                                                                                                                                                                                                                                       | Supported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `registerProvider`, `registerVirtualModel`                                                                                                                                                                                                                                        | Not supported: the host makes model calls with the `models` given to `attach`. While loading, reported in `errors`, and the extension keeps the rest; later, they throw.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Commands, shortcuts, renderers, UI                                                                                                                                                                                                                                                | Accepted and unused, as in Pi's print mode: `ctx.hasUI` is false.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Outside `before_agent_start` handlers, `ctx.getSystemPrompt()` returns an empty prompt and `ctx.getContextUsage()` returns nothing, because pi-durable builds the prompt for each request and does not expose it. Handlers for Pi's other events, such as `agent_settled`, `session_compact`, `session_tree` and `message_update`, are accepted and never run. Session names, labels and `ctx.shutdown()` do nothing. Every other Pi API either does nothing here or throws an error saying it is not supported.

### Runs

pi-durable has no hook where a run starts, so `before_agent_start` and `agent_start` run once per run, at its first request. They get the first input that started the run as the prompt, or as a custom message when an extension sent it with `triggerTurn`. They do not run again when the run continues after an answer or a failure. A follow-up placed after a run's answer starts a run of its own, where Pi keeps it in the same run.

What `before_agent_start` handlers add to `systemPromptOptions` (`sections`, `appendSystemPrompt`, `promptGuidelines`) is added to each of the run's requests, also after a restart in the middle of the run. A message they return goes with the first request and is saved to the conversation after its answer. A changed `selectedTools` applies from the next request. A returned `systemPrompt` is ignored, because pi-durable builds the prompt; `event.systemPrompt` and `ctx.getSystemPrompt()` show the prompt Pi would build from the options. A section whose name Pi rejects is reported to `onError` and left out, where Pi fails the run.

`message_end` is for the model's messages only. Each response has a turn, a failed attempt's included, and one that calls no tool ends its turn before it is saved, so its `turn_end` has no entry ID. A retry stays in the run, where Pi ends the run and starts it again (`agent_end`, `agent_start`). `agent_end` follows only runs that answered.

## Tested extensions

| Extension                                                      | Version | What was checked                                                             |
| -------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------- |
| [`pi-web-access`](https://www.npmjs.com/package/pi-web-access) | 0.47.0  | Loads and registers its tools; `fetch_content` fetches pages and reads PDFs. |
| [`pi-web-search`](https://www.npmjs.com/package/pi-web-search) | 1.7.0   | Loads and registers its tools.                                               |

Only the extensions in this table are tested. An extension outside it has what the [table above](#what-extensions-get) lists to work with, within the limits below.

## Limits

- Extensions can do anything your process can, as in Pi: they run in its worker threads with its permissions. Only `pi.exec` goes through the `env` you give `attach`, so a sandboxed `env` does not contain an extension that reads files or starts programs itself. Install only extensions you trust.
- An extension's module-level state is shared by the conversations on its worker, where in Pi one session has the process to itself. State kept in its factory is per conversation.
- A crash inside a native add-on ends your whole process; worker threads share it.
- Extensions that run work in Pi processes of their own, as `pi-subagents` does for its subagents, are not supported.
- After a crash of your process, pi-durable does not run an interrupted extension tool again.

## Elflodge

This package comes from [Elflodge](https://elflodge.com), an open-source project for running hundreds of agents unattended behind one job API. It runs sandboxed agents in parallel on your own machine, without a costly fleet of hosted sandboxes: you send a task or a whole batch and get structured results your code can use.

You define the agent's instructions and output schema once. Each job runs Pi with real files and shell commands in its own sandbox and returns JSON checked against your schema, or a failure with its reason. The first five jobs run before the rest, and a Batch pauses itself when too many fail.

Given a folder of invoices and a JSON Schema for what you want from each, one command runs them all:

```sh
npx elflodge batches submit \
  --id invoices \
  --each invoices/*.pdf \
  --instructions "Extract the supplier, number, currency and total." \
  --output-schema invoice.schema.json \
  --wait \
  --output-dir ./results
```

Elflodge's Runner hosts many such jobs in one process, and this package was built so that their agents can use Pi's extensions there. The website is [elflodge.com](https://elflodge.com) and the source, this package's included, is at [elflodge/elflodge](https://github.com/elflodge/elflodge).

This package is not part of Pi. When pi-durable can run coding-agent extensions itself, this README will point you to it.

Licensed under MIT.
