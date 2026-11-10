import { fork } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Type, { type Static } from "typebox";
import { Value } from "typebox/value";

/** The child process's module beside this one: `.ts` from source, `.mjs` built. */
const processModule = fileURLToPath(
  new URL(`./prepare-process${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url),
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
  /** Pi's `npmCommand` setting: the command that runs npm, with its arguments. Default `["npm"]`. */
  readonly npmCommand?: readonly string[];
  /**
   * Stops preparing: the child process ends and the promise rejects with Node's `AbortError`, the
   * signal's reason as its `cause`. A package manager it started goes on until it is done.
   */
  readonly signal?: AbortSignal;
}

/** One extension's module in the bundle. */
export interface PreparedExtension extends Static<typeof PreparedExtension> {}
const PreparedExtension = Type.Object({
  /** The source it came from, as given. */
  source: Type.String(),
  path: Type.String(),
});

/** The bundle `startExtensionHost` runs. */
export interface PreparedExtensions extends Static<typeof PreparedExtensions> {}
const PreparedExtensions = Type.Object({
  /** This package's runtime in the bundle, which shares Pi's code with the extensions. */
  runtime: Type.String(),
  extensions: Type.Array(PreparedExtension),
  /** The native add-ons the extensions load, which the host loads in its main thread first. */
  addons: Type.Array(Type.String()),
  /** Sources that could not be installed or bundled, with the reason; the rest are prepared without them. */
  failures: Type.Array(Type.Object({ source: Type.String(), message: Type.String() })),
});

/** What the child process replies. */
const PrepareReply = Type.Union([PreparedExtensions, Type.Object({ error: Type.String() })]);

/**
 * Installs the extension packages `sources` with Pi's own package manager, as `pi install` does, and
 * bundles their extensions and this package's runtime with Rolldown into one build that keeps only
 * the parts of Pi's packages they use.
 *
 * It runs in a child process of its own, which exits when it is done: installing loads the whole
 * coding agent and bundling loads Rolldown, several hundred MiB for a few extensions. A worker
 * thread would leave most of it in the host's memory after it exits, as Rolldown's native runtime,
 * its threads and their memory stay in the process; a process returns it.
 */
export async function prepareExtensions(options: PrepareOptions): Promise<PreparedExtensions> {
  // The child's output, the package manager's included, goes to standard error, as Pi sends a
  // package manager's when its standard output carries a protocol (`package-manager.js`).
  const child = fork(processModule, {
    stdio: ["ignore", 2, 2, "ipc"],
    ...(options.signal && { signal: options.signal }),
  });
  // A failure to start rejects the wait for the reply; one after it has no one to report to.
  child.on("error", () => {});
  // `close` comes after the channel has delivered every message, unlike `exit`.
  const exited = new Promise<never>((_resolve, reject) => {
    child.once("close", (code, signal) => {
      const how = code === null ? `signal ${String(signal)}` : `code ${code}`;
      reject(new Error(`Preparing extensions failed: the process exited with ${how}`));
    });
  });
  child.send({
    sources: [...options.sources],
    dir: options.dir,
    ...(options.npmCommand && { npmCommand: [...options.npmCommand] }),
  });
  const [message] = await Promise.race([once(child, "message"), exited]);
  Value.Assert(PrepareReply, message);
  if ("error" in message) throw new Error(`Preparing extensions failed: ${message.error}`);
  return message;
}
