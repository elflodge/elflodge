import solid from "@solidjs/vite-plugin";
import { tanstackStart } from "@tanstack/solid-start/plugin/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  // Where the hub serves the dashboard (ADR 0043); TanStack Start derives the router's basepath from
  // it. It is repeated in `apps/hub/src/dashboard.ts` for the Node hub, and in
  // `apps/hub/wrangler.jsonc` and `public/_headers` for the Workers hub.
  base: "/dashboard/",
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
      // A static app shell the hub serves (ADR 0043), with no server of its own. The shell is
      // written as `index.html`, the file Workers Static Assets answer a navigation with when it
      // matches no other, rather than Start's default `_shell.html`.
      spa: { enabled: true, prerender: { outputPath: "/index" } },
    }),
    solid({ ssr: true }),
  ],
});
