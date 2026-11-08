# Pi extensions run through a published compat package

Pi coding-agent extensions run on pi-durable through `@elflodge/pi-durable-compat`, a package of its own in this workspace, published with the same version as the rest (ADR 0032). It imports nothing of Elflodge, so any pi-durable host can use it; pi-durable has no way to run coding-agent extensions itself (earendil-works/pi#10386).

A host prepares the extensions once: Pi's own package manager installs them, as `pi install` does, and Rolldown bundles them with the package's runtime into one build, treating Pi's packages as free of side effects so only the parts in use remain. The bundle resolves Pi's packages as Pi's loader does for extensions, from the package's own copy of the coding agent, with pi-ai's root as Pi's extension view of it and Pi's former package names. Extensions run in a few worker threads shared by all conversations, with one instance of each extension per conversation. A conversation's instance is created when the host attaches it. The host installs one pi-durable extension per registry, `pi-durable-compat`, with every attached conversation's tools and only the hooks some extension listens to, and its tools and hooks act for the attached conversation they run in. pi-durable selects every installed extension for every conversation by default and lets a later tool replace one of the same name, so extensions installed per conversation would take each other's tools. Hooks and tools know only their conversation's ID, which is unique within one Harness, so a registry serves one Harness.

In the worker, the package builds the `pi` object each extension's factory receives itself, filling Pi's exported `Extension` record as Pi's `createExtensionAPI` does, with `exec` running in the host's environment. Pi's root reaches its loader only through `DefaultResourceLoader`, whose every load scans the working directory, its ancestors and the user's home for skills and settings, and which adds about 18 to 21 MiB per worker, measured twice; and its `exec` spawns on the host either way. It dispatches events through Pi's exported `ExtensionRunner`, so handler order, how results combine and how a failing handler is isolated are Pi's own, and follow Pi's releases. The runner takes Pi's `SessionManager` and `ModelRegistry` classes, which it only hands to extensions as `ctx.sessionManager` and `ctx.modelRegistry`; the package passes objects with the methods extensions use, over the host's journal and models, with one type assertion each. Reads of the history and the agent are synchronous in Pi, so the worker waits for the host's answer (`sync-message-port`); the host never waits for a worker, and pi-durable runs hooks off its Session line, so a handler can read the history too. Writes such as `appendEntry` travel on the same channel and the host carries them out before a later read, so an extension reads what it just wrote, as in Pi. pi-durable runs a tool's `prepareArguments` synchronously on the host, so for a tool that has one the host parses arrays and objects sent as JSON text, and the worker runs the tool's own before executing.

Measured with `pi-web-search` and `pi-web-access`, PSS per worker on Node 26: about 99 MiB loaded as shipped, 24 bundled, 26.5 with the runtime and Pi's runner.

## Considered options

- A process per conversation, or extensions loaded as shipped: about 99 MiB per instance or worker, for a Runner that hosts hundreds of conversations.
- Pi's loader through an internal file path: Pi's package exports only its root, and a release can move the file.
- Pi's loader through `DefaultResourceLoader`'s `extensionFactories`: the disk scans and the memory above.
- One pi-durable extension per conversation: under pi-durable's default selection, the conversations' tools replace each other.
- The host selecting each conversation's extension with pi-durable's `extensions` setting: every host would have to set its default selection and handle the conversations a conversation creates.
- Caching the bundle between starts: a key that misses a change, such as an upgrade of this package or an edited local extension, runs an old build, to save about a second at start.
- Dispatching events with code of our own: about 400 lines that repeat Pi's runner and drift from it with each release.
- A real `ModelRegistry` in each worker: it needs Pi's `ModelRuntime`, which loads every built-in provider, 55 MiB per worker instead of 26.5.
- A synchronous call from the host to the worker for `prepareArguments`: a host waiting on a busy worker would stall every conversation.
- Effect's `Pool` for the workers: it caps how many borrowers an item takes and makes the rest wait, while a conversation keeps its worker for as long as it runs.

## Consequences

Extensions run with the host process's permissions; a worker thread is not a sandbox. Module-level state is shared by the conversations on a worker. An extension that does not bundle is not loaded. A tool's own `prepareArguments` runs after pi-durable has validated the arguments. When pi-durable can run coding-agent extensions itself, the package's README points to it.

Reconsider building the `pi` object when Pi's root exports `loadExtensionFromFactory`, ideally with a way to run `exec` elsewhere, or `DefaultResourceLoader` loads inline factories without scanning; the facades when the runner's parameters become interfaces; the one-Harness rule when hooks and tools learn their Harness; the scheduler if Effect gains a pool that places borrowers without capping them.
