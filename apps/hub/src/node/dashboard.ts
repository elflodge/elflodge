import path from "node:path";

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

import { DASHBOARD_BASE } from "../app.ts";

/**
 * The dashboard's files under its base path, from `root`, its build, as Workers Static Assets serve
 * them on the Workers hub (`wrangler.jsonc`): the hashed assets and the notices as they are, and the
 * app shell for every other path, which the app routes in the browser. Only those files, so a hub run
 * from source, whose `root` is the dashboard's whole build, serves what the built hub serves.
 */
export function dashboardFiles(root: string) {
  return (
    new Hono()
      // The base path without its `/`, redirected as Workers Static Assets redirect it, query kept.
      .get("/", (c) => c.redirect(DASHBOARD_BASE + new URL(c.req.url).search, 307))
      .use(
        "/assets/*",
        serveStatic({
          root,
          // The path under the base path, with its leading `/`.
          rewriteRequestPath: (requestPath) => requestPath.slice(DASHBOARD_BASE.length - 1),
          // Vite names each file under `assets` by a hash of its content, so a browser may keep it
          // for a year, as `_headers` tells Workers.
          onFound: (_found, c) => {
            c.header("Cache-Control", "public, max-age=31536000, immutable");
          },
        }),
      )
      // A missing asset, such as a script of an earlier build that an open page asks for, is a 404:
      // the shell in its place would fail as a script anyway.
      .get("/assets/*", (c) => c.notFound())
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
