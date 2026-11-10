# The CLI is the public package for users; the hub and runner stay private

Elflodge publishes one npm package for its users, `elflodge`: the CLI, which calls the hub over HTTP. The package `agent-batch` only runs it under its earlier name (ADR 0037). `@elflodge/pi-durable-extension-adapter`, which runs Pi coding-agent extensions on pi-durable, is published for any pi-durable host and imports nothing of Elflodge (ADR 0038). The hub and runner are private workspace packages distributed as separate images. Callers submit prompts, input files and output schemas through the API. Publishing the hub or runner as a library now would freeze internals that are still changing.

## Consequences

Publish the runner as `@elflodge/runner` once the job API has settled and a user has a concrete need that scripts, config and the API cannot meet (custom runner code, embedding, full control of its configuration). Publishing it later only adds a package.
