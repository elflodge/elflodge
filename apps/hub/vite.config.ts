import { externals } from "nf3/plugin";
import { configDefaults, defaultServerConditions, defineConfig } from "vite-plus";

import { DASHBOARD_ASSETS } from "./src/dashboard.ts";

export default defineConfig({
  // The tests start a Runner in this process, which loads the extension adapter's source under the
  // condition its exports give it in the workspace (ADR 0006).
  ssr: { resolve: { conditions: ["@elflodge/source", ...defaultServerConditions] } },
  run: {
    tasks: {
      // Each serves the dashboard's build, so builds it first: the Node hub's build copies it, and
      // Wrangler uploads it as the Worker's static assets.
      build: { command: "vp pack", dependsOn: ["dashboard#build"] },
      dev: { command: "wrangler dev", dependsOn: ["dashboard#build"], cache: false },
      deploy: { command: "wrangler deploy", dependsOn: ["dashboard#build"], cache: false },
      // Not cached: each run reads the database, and may print a new setup link, to a terminal.
      setup: { command: "node scripts/setup.ts", cache: false },
    },
  },
  pack: {
    // The Node hub, which the Docker image runs; the Worker is built by Wrangler.
    entry: ["src/main.ts"],
    dts: false,
    // nf3, Nitro's tracer, copies only the third-party files the hub loads into `dist/node_modules`,
    // manifests included, so image scanners still see each package. `contract` exports TypeScript
    // source, so it is bundled instead (ADR 0006).
    deps: { alwaysBundle: ["contract"] },
    plugins: [externals({ exclude: ["contract"] })],
    // The files of the dashboard's build that browsers fetch, which the Node hub serves, beside it
    // (`src/main.ts`): the build's other files are for Vite and Workers.
    copy: [
      {
        from: [
          "../dashboard/dist/client/index.html",
          `../dashboard/dist/client/${DASHBOARD_ASSETS}`,
          "../dashboard/dist/client/THIRD_PARTY_NOTICES.md",
        ],
        to: "dist/dashboard",
      },
    ],
  },
  test: {
    globalSetup: ["./tests/global-setup.ts"],
    // Test files share one Postgres, so they run one at a time.
    fileParallelism: false,
    // Tests of the Docker image need Docker and an image build, so the default run skips them;
    // `vp test --tags-filter=container` runs only them (ADR 0003).
    tags: [{ name: "container", timeout: 600_000 }],
    tagsFilter: ["!container"],
    // The hub runs on Workers and in Docker alike, so the suite runs against each (ADR 0003), each
    // project with a Postgres of its own.
    projects: [
      {
        extends: true,
        test: {
          name: "workers",
          provide: { hub: "workers" },
          // These run a Runner against a server of their own, never the hub, so the Node project
          // alone runs them.
          exclude: [
            ...configDefaults.exclude,
            "tests/runner-reports.test.ts",
            "tests/runner-stop.test.ts",
          ],
        },
      },
      { extends: true, test: { name: "node", provide: { hub: "node" } } },
    ],
  },
});
