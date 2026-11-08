import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { Schema } from "effect";

/** The worker's module beside this one: `.ts` from source, `.mjs` built. */
const workerModule = fileURLToPath(
  new URL(`./prepare-worker${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);

/** What `prepareExtensions` installs and bundles. */
export interface PrepareOptions {
  /**
   * The extension packages, as Pi's settings name them: `npm:pi-web-access@0.47.0`, a git URL or a
   * local path. Pin npm versions: an unpinned one is installed at whatever version is latest.
   */
  readonly sources: readonly string[];
  /**
   * A directory kept between starts, for one process at a time: Pi installs the packages there and
   * reuses them while the sources stay the same, and the bundle is built there again on every call.
   */
  readonly dir: string;
}

/** One extension's module in the bundle. */
export interface PreparedExtension extends Schema.Schema.Type<typeof PreparedExtension> {}
const PreparedExtension = Schema.Struct({
  /** The source it came from, as given. */
  source: Schema.String,
  path: Schema.String,
});

/** The bundle `startExtensionHost` runs. */
export interface PreparedExtensions extends Schema.Schema.Type<typeof PreparedExtensions> {}
const PreparedExtensions = Schema.Struct({
  /** This package's runtime in the bundle, which shares Pi's code with the extensions. */
  runtime: Schema.String,
  extensions: Schema.Array(PreparedExtension),
  /** Sources that could not be installed or bundled, with the reason; the rest are prepared without them. */
  failures: Schema.Array(Schema.Struct({ source: Schema.String, message: Schema.String })),
});

/** What the worker replies. */
const PrepareReply = Schema.Union([PreparedExtensions, Schema.Struct({ error: Schema.String })]);

/**
 * Installs the extension packages `sources` with Pi's own package manager, as `pi install` does, and
 * bundles their extensions and this package's runtime with Rolldown into one build that keeps only
 * the parts of Pi's packages they use.
 *
 * It runs in a worker thread of its own, which exits when it is done: installing loads the whole
 * coding agent and bundling loads Rolldown, and neither stays in the host's memory.
 */
export async function prepareExtensions(options: PrepareOptions): Promise<PreparedExtensions> {
  const worker = new Worker(workerModule, {
    workerData: { sources: [...options.sources], dir: options.dir },
  });
  const [message] = await once(worker, "message");
  await worker.terminate();
  const reply = Schema.decodeUnknownSync(PrepareReply)(message);
  if ("error" in reply) throw new Error(`Preparing extensions failed: ${reply.error}`);
  return reply;
}
