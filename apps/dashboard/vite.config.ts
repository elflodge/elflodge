import solid from "@solidjs/vite-plugin";
import { tanstackStart } from "@tanstack/solid-start/plugin/vite";
import { createFixture, type FileTree } from "fs-fixture";
import type { BrowserContext } from "playwright";
import { configDefaults, defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";
import type { SerializedLocator } from "vite-plus/test/browser/context";

import { DASHBOARD_ASSETS, DASHBOARD_BASE } from "../hub/src/dashboard.ts";

/** Files and folders to drop, by name: a text is a file's, and an object a folder's entries. */
export interface Dropped {
  [name: string]: string | Dropped;
}

/**
 * The browser contexts that refuse to open a file: dropped where nothing takes it, a file is the
 * browser's to open in the tab, which would replace the tests' page.
 */
const refusingFiles = new WeakSet<BrowserContext>();

/** The browser the tests run in, in the locale and time zone their expectations are written in. */
const BROWSER_CONTEXT = {
  locale: "en-US",
  timezoneId: "UTC",
  permissions: ["clipboard-read", "clipboard-write"],
};

export default defineConfig({
  run: {
    tasks: {
      // A task, which Vite Task caches, where a `package.json` script would run every time.
      test: { command: "vp test" },
    },
  },
  test: {
    // Each project takes the plugins it needs: a top-level `test` would load the build's with the rest
    // of this config, and `extends: false` leaves them out.
    projects: [
      {
        extends: false,
        test: {
          name: "node",
          include: ["tests/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "tests/browser/**"],
        },
      },
      {
        extends: false,
        plugins: [solid()],
        // As for the app below: UI SDK's installation guide asks for it.
        optimizeDeps: { exclude: ["@ui-sdk/core"] },
        test: {
          name: "browser",
          setupFiles: ["tests/browser/setup.ts"],
          include: ["tests/browser/**/*.test.ts"],
          browser: {
            enabled: true,
            provider: playwright({ contextOptions: BROWSER_CONTEXT }),
            headless: true,
            instances: [
              {
                browser: "chromium",
                exclude: [
                  ...configDefaults.exclude,
                  "**/*.touch.test.ts",
                  "**/*.los-angeles.test.ts",
                ],
              },
              // A tap needs touch, which also makes the pointer coarse for the page's styles.
              {
                browser: "chromium",
                name: "chromium-touch",
                include: ["tests/browser/**/*.touch.test.ts"],
                provider: playwright({ contextOptions: { ...BROWSER_CONTEXT, hasTouch: true } }),
              },
              // A time zone west of UTC, which the browser's context sets.
              {
                browser: "chromium",
                name: "chromium-los-angeles",
                include: ["tests/browser/**/*.los-angeles.test.ts"],
                provider: playwright({
                  contextOptions: { ...BROWSER_CONTEXT, timezoneId: "America/Los_Angeles" },
                }),
              },
            ],
            // Playwright's default.
            viewport: { width: 1280, height: 720 },
            commands: {
              // Vitest has no tap: Playwright's, in the frame the tests run in.
              async tap(context, locator: SerializedLocator) {
                await (await context.frame()).locator(locator.selector).tap();
              },
              // Nor a drop of files: written to disk and dropped through Chromium's own hit test, as
              // a person drops them, 10 pixels into the start of the element, which shows first.
              // Playwright's `locator.drop()` builds the data in the page, which carries no folders,
              // and dispatches its events on the element, past what covers it.
              async drop(context, locator: SerializedLocator, entries: Dropped) {
                const browser = context.page.context();
                // On disk until the browser closes, as the page reads the files after the drop.
                const folder = await createFixture(entries satisfies FileTree);
                browser.once("close", () => void folder.rm());
                const target = (await context.frame()).locator(locator.selector);
                await target.scrollIntoViewIfNeeded();
                const box = await target.boundingBox();
                if (!box) throw new Error(`Nothing to drop on: ${locator.selector}`);
                if (!refusingFiles.has(browser)) {
                  refusingFiles.add(browser);
                  // Refused, as the network refuses what it cannot reach.
                  await browser.route(
                    (url) => url.protocol === "file:",
                    (route) => route.abort(),
                  );
                }
                const input = await browser.newCDPSession(context.page);
                try {
                  const at = { x: box.x + 10, y: box.y + box.height / 2 };
                  const files = Object.keys(entries).map((name) => folder.getPath(name));
                  const data = { items: [], files, dragOperationsMask: 1 };
                  for (const type of ["dragEnter", "dragOver", "drop"] as const)
                    await input.send("Input.dispatchDragEvent", { type, ...at, data });
                } finally {
                  await input.detach();
                }
              },
            },
          },
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
