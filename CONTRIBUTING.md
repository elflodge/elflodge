# Contributing

Elflodge does not accept outside code contributions for now: only the repository's collaborators can open pull requests.

Issues are welcome: a bug report with the steps that reproduce it, or a request that describes what you need.

## Development

The repository is a pnpm workspace run with Vite+ (`vp`). From a clone:

- `vp install` installs the dependencies.
- `vp run ready` checks everything is ready.
- `vp run -r test` runs the tests.
- `vp run -r build` builds the monorepo.
- `vp run dev` in `apps/hub` runs the hub's development server; in `apps/runner` or `packages/cli` it rebuilds the package on every change.

Inside the clone, npm refuses `npx elflodge` because the workspace declares pnpm as its package manager; run the published CLI from another directory.

## Releasing

To release, merge the release PR that release-please keeps open. It publishes the hub's and the Runner's images and stages the `elflodge` CLI and its `agent-batch` alias on npm; approve both staged versions on npmjs.com, or with `npm stage approve`, `elflodge` first, since the alias depends on it. To release a version other than the one it proposes, merge a commit whose body has `Release-As: x.y.z`.
