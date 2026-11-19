import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vite-plus/test/node";

import { migrateDatabase } from "../src/db/migrate.ts";

declare module "vite-plus/test" {
  interface ProvidedContext {
    databaseUrl: string;
  }
}

/**
 * Builds the dashboard, which both hubs serve from its build, and starts one migrated Postgres for
 * the test run; the hub reaches it through Hyperdrive's local connection string. Vite Task replays
 * the dashboard's build when nothing it reads has changed.
 */
export default async function setup(project: TestProject) {
  // Without Vitest's `NODE_ENV`, `test`, with which Vite would build the libraries' development
  // builds: the build the hubs ship.
  const env = { ...process.env };
  delete env.NODE_ENV;
  // First, so a failed build leaves no container behind.
  await promisify(execFile)(
    path.join(import.meta.dirname, "../node_modules/.bin/vp"),
    ["run", "dashboard#build"],
    { env },
  );
  await using resources = new AsyncDisposableStack();
  const container = resources.use(await new PostgreSqlContainer("postgres:18-alpine").start());
  const databaseUrl = container.getConnectionUri();
  await migrateDatabase(databaseUrl);
  project.provide("databaseUrl", databaseUrl);
  const teardown = resources.move();
  return () => teardown.disposeAsync();
}
