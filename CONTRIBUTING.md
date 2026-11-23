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
- `vp dev` in `apps/dashboard` serves the dashboard with hot reloading and passes every other path to the hub's development server at `http://127.0.0.1:8787`, or at `DEV_HUB_URL`. For that hub to sign members in, its `HUB_URL` is the dashboard server's origin, such as `http://localhost:5173`.
- The dashboard's tests and the journeys through its pages, in `apps/hub/tests/journeys`, drive Chromium through Playwright; `vp exec playwright install --with-deps --only-shell chromium` in `apps/hub` installs it for both.

Inside the clone, npm refuses `npx elflodge` because the workspace declares pnpm as its package manager; run the published CLI from another directory.

## Releasing

To release, merge the release PR that release-please keeps open. It publishes the hub's and the Runner's images and stages the `elflodge` CLI, its `agent-batch` alias and `@elflodge/pi-durable-extension-adapter` on npm; approve the staged versions on npmjs.com, or with `npm stage approve`, `elflodge` before the alias, since the alias depends on it. npm sets up trusted publishing on a package that exists, so a new package's first version is published by hand, and the release workflow is added as its trusted publisher before the release that stages it. To release a version other than the one it proposes, merge a commit whose body has `Release-As: x.y.z`.
