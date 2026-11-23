import solid from "@solidjs/vite-plugin";
import { tanstackStart } from "@tanstack/solid-start/plugin/vite";
import { configDefaults, defineConfig } from "vite-plus";

import { DASHBOARD_ASSETS, DASHBOARD_BASE } from "../hub/src/dashboard.ts";

export default defineConfig({
  run: {
    tasks: {
      // Not cached: Vite Task traces a cached task's file reads by preloading a library into every
      // process it starts, and under that tracing the tests' setup cannot start the dashboard's build
      // through Vite Task, which fails to spawn it. The build itself stays cached.
      test: { command: "vp test", cache: false },
    },
  },
  test: {
    // The browser tests import none of the dashboard's source, so Vitest's module graph cannot tell
    // when an edit concerns them: any change to it reruns every test, and the global setup builds it
    // again.
    forceRerunTriggers: [
      ...configDefaults.forceRerunTriggers,
      `${import.meta.dirname}/src/**`,
      `${import.meta.dirname}/public/**`,
    ],
    // The tests run in Node, import none of the dashboard's components and drive the build in a
    // browser, so the build's plugins have nothing to do in them; a top-level `test` would load them
    // with the rest of this config, and `extends: false` leaves them out.
    projects: [
      {
        extends: false,
        test: {
          include: ["tests/**/*.test.ts"],
          // Builds the dashboard and serves the build for the run.
          globalSetup: ["tests/global-setup.ts"],
          testTimeout: 15_000,
        },
      },
    ],
  },
  // TanStack Start derives the router's basepath from this Vite base.
  base: DASHBOARD_BASE,
  build: { assetsDir: DASHBOARD_ASSETS },
  environments: {
    client: {
      build: {
        // The licences of the packages the browser's bundle carries, in the build the hub serves, as
        // the CLI's bundle carries its own. Only the browser's: the server build only renders the
        // shell. Markdown, the format Vite writes them in.
        license: { fileName: "THIRD_PARTY_NOTICES.md" },
      },
    },
  },
  optimizeDeps: {
    // UI SDK's installation guide asks for this with Vite: pre-bundled, a core entry an app imports
    // is a second copy beside the one @ui-sdk/solid loads, and its parts throw in development. The
    // dashboard imports core's `announce` and `prepareAnnouncements` for `CopyButton`.
    exclude: ["@ui-sdk/core"],
  },
  server: {
    // `vp dev` serves the dashboard and sends every other path, the hub's API and Better Auth's
    // routes among them, to a hub running locally, by default `wrangler dev`'s in `apps/hub`, so
    // that the page and the hub share an origin as they do when the hub serves the dashboard.
    // WebSockets too, such as a Runner's connection.
    proxy: {
      "^/(?!dashboard/)": { target: process.env.DEV_HUB_URL ?? "http://127.0.0.1:8787", ws: true },
    },
  },
  preview: {
    // Start renders the shell by fetching it from Vite's preview server, which listens on
    // `localhost` by default. In a Docker build on Node 26, the server listens on `::1` while the
    // fetch connects to `127.0.0.1` (TanStack/router#6275); an IPv4 address leaves no choice to
    // make. This can go once Start binds the server to it itself (TanStack/router#6305).
    host: "127.0.0.1",
  },
  plugins: [
    tanstackStart({
      // The hub serves a static shell (ADR 0043). Cloudflare's single-page-application handling
      // serves `index.html` for an unmatched navigation, so Start must write the shell at that path.
      spa: { enabled: true, prerender: { outputPath: "/index" } },
    }),
    solid({ ssr: true }),
  ],
});
