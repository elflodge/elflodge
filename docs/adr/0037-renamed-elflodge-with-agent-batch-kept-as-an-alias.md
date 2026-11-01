# Renamed Elflodge, with agent-batch kept as an alias

The project, its repository, npm package, command, images, environment variables, Compose project, database schema and Runner protocol identifiers are named Elflodge (`elflodge`) instead of agent-batch. The command is installed as `elflodge` and as its short form `elf`. The npm package `agent-batch` stays as a package of its own: it depends on `elflodge` at the same version and runs it as `agent-batch`, so `npx agent-batch` and existing installs keep working; it is released with every version and never deprecated. The repository moved from `chuse-ai/agent-batch` to `elflodge/elflodge`, which GitHub redirects, and the images published as `ghcr.io/chuse-ai/agent-batch-{hub,runner}` stay where they are for the versions that pull them.

"agent-batch" describes what the software does, which makes it a weak name to search for or to own. npm cannot rename a package, so a new name is a new package; one that only forwards to the new one keeps the old name's links and commands alive at the cost of one small package per release.

Names inside the software were renamed with the project and read no old name, since no deployment depended on them: a hub, Runner or stack from before keeps its data under the old names, and the new ones start empty.

## Considered options

- Deprecating `agent-batch` on npm after a while: links to it in old posts and scripts would then warn or break, for a saving of one package per release.
- Keeping the old environment variable names as fallbacks: it would carry two names for each setting indefinitely, for users the software did not yet have.
- `elf` alone as the product name: unsearchable, crowded as a trademark and the name of a binary format; it stays the short command.
