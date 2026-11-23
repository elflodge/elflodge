import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { preview } from "vite-plus";
import type { TestProject } from "vite-plus/test/node";

import { DASHBOARD_BASE } from "../../hub/src/dashboard.ts";

declare module "vite-plus/test" {
  interface ProvidedContext {
    /** Where the build is served, on loopback. */
    dashboardOrigin: string;
    /** The paths of the build's files, the only ones besides its navigations a page may fetch. */
    dashboardFiles: string[];
  }
}

/**
 * Builds the dashboard as the hubs serve it and serves the build with Vite's preview server. Vite
 * Task replays the build when nothing it reads has changed, so each run tests the source as it is.
 */
export default async function setup(project: TestProject) {
  const root = path.resolve(import.meta.dirname, "..");
  // Without Vitest's `NODE_ENV`, `test`, with which Vite would build the libraries' development
  // builds: the build the hubs ship.
  const env = { ...process.env };
  delete env.NODE_ENV;
  await promisify(execFile)(path.join(root, "node_modules/.bin/vp"), ["run", "dashboard#build"], {
    cwd: root,
    env,
  });
  const client = path.join(root, "dist/client");
  const entries = await readdir(client, { recursive: true, withFileTypes: true });
  project.provide(
    "dashboardFiles",
    entries
      .filter((entry) => entry.isFile())
      .map(
        (entry) => DASHBOARD_BASE + path.relative(client, path.join(entry.parentPath, entry.name)),
      ),
  );
  // Without the dashboard's config, whose plugins are for building it.
  const server = await preview({
    root,
    configFile: false,
    base: DASHBOARD_BASE,
    build: { outDir: client },
    preview: { host: "127.0.0.1", port: 0 },
  });
  const address = server.httpServer.address();
  if (!address || typeof address === "string") {
    await server.close();
    throw new Error("Vite's preview server is not listening on a TCP port");
  }
  project.provide("dashboardOrigin", `http://127.0.0.1:${address.port}`);
  return () => server.close();
}
