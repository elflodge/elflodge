import path from "node:path";

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

import { DASHBOARD_ASSETS, DASHBOARD_BASE } from "../dashboard.ts";

/**
 * Serves the dashboard under its base path from the build at `root`. A hub run from source has
 * Vite's private build files there too, so it exposes only the dashboard assets, notices and shell.
 */
export function dashboardFiles(root: string) {
  return (
    new Hono()
      // The base path without its `/`, redirected as Workers Static Assets redirect it, query kept.
      .get("/", (c) => c.redirect(DASHBOARD_BASE + new URL(c.req.url).search, 307))
      .get(
        `/${DASHBOARD_ASSETS}/*`,
        serveStatic({
          root,
          // The path under the base path, with its leading `/`.
          rewriteRequestPath: (requestPath) => requestPath.slice(DASHBOARD_BASE.length - 1),
          // Vite's content hashes and Scalar's package version let browsers reuse these assets
          // for a year, as the dashboard's _headers tells Workers.
          onFound: (_found, c) => {
            c.header("Cache-Control", "public, max-age=31536000, immutable");
          },
        }),
        // A missing asset, such as a script of an earlier build that an open page asks for, is a
        // 404: the shell in its place would fail as a script anyway.
        (c) => c.notFound(),
      )
      .get(
        "/THIRD_PARTY_NOTICES.md",
        serveStatic({
          path: path.join(root, "THIRD_PARTY_NOTICES.md"),
          onFound: (_found, c) => {
            // Hono's MIME table has no `.md`, so it would send the file as a download.
            c.header("Content-Type", "text/markdown; charset=utf-8");
            c.header("Cache-Control", "no-cache");
          },
        }),
      )
      .get(
        "*",
        serveStatic({
          path: path.join(root, "index.html"),
          onFound: (_found, c) => {
            c.header("Cache-Control", "no-cache");
          },
        }),
      )
  );
}
