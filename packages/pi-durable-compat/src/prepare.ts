import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

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
   * A directory kept between starts, where Pi installs the packages and the bundle is written; both
   * are reused while the sources and their installed versions stay the same.
   */
  readonly dir: string;
}

/** One extension's module in the bundle. */
export interface PreparedExtension {
  /** The source it came from, as given. */
  readonly source: string;
  readonly path: string;
}

/** The bundle `startExtensionHost` runs. */
export interface PreparedExtensions {
  /** This package's runtime in the bundle, which shares Pi's code with the extensions. */
  readonly runtime: string;
  readonly extensions: readonly PreparedExtension[];
  /** Sources that could not be installed or bundled, with the reason; the rest are prepared without them. */
  readonly failures: readonly { readonly source: string; readonly message: string }[];
}

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
  const [result] = await once(worker, "message");
  await worker.terminate();
  return parseResult(result);
}

function parseResult(value: unknown): PreparedExtensions {
  if (typeof value !== "object" || value === null) throw new Error("Preparing extensions failed");
  if ("error" in value) throw new Error(`Preparing extensions failed: ${String(value.error)}`);
  if (!("extensions" in value) || !("failures" in value)) {
    throw new Error("Preparing extensions gave no result");
  }
  const { extensions, failures } = value;
  if (!Array.isArray(extensions) || !Array.isArray(failures)) {
    throw new Error("Preparing extensions gave no result");
  }
  if (!("runtime" in value) || typeof value.runtime !== "string") {
    throw new Error("Preparing extensions gave no runtime");
  }
  return {
    runtime: value.runtime,
    extensions: extensions.map((each: unknown) => {
      if (
        typeof each === "object" &&
        each !== null &&
        "source" in each &&
        typeof each.source === "string" &&
        "path" in each &&
        typeof each.path === "string"
      ) {
        return { source: each.source, path: each.path };
      }
      throw new Error("Preparing extensions gave a malformed extension");
    }),
    failures: failures.map((each: unknown) => {
      if (
        typeof each === "object" &&
        each !== null &&
        "source" in each &&
        typeof each.source === "string" &&
        "message" in each &&
        typeof each.message === "string"
      ) {
        return { source: each.source, message: each.message };
      }
      throw new Error("Preparing extensions gave a malformed failure");
    }),
  };
}
