import { createHash } from "node:crypto";
import path from "node:path";

import { hook, ToolTask } from "@earendil-works/pi-durable";
import {
  type ExtensionHost,
  type PreparedExtensions,
  prepareExtensions,
  startExtensionHost,
} from "@elflodge/pi-durable-extension-adapter";
import { Data, Effect, FileSystem, Schema } from "effect";
import { ChildProcess } from "effect/process";
import ensureError from "ensure-error";

import { NodeServices, runCommand } from "./sandbox.ts";

// Pi coding-agent extensions in jobs, through `@elflodge/pi-durable-extension-adapter` (ADR 0038):
// installed and bundled once as the Runner starts, run in a few worker threads the Runner's jobs
// share, and attached to each job's conversation while its agent runs.

/**
 * The directory in the Runner's data directory that holds the installed extensions: one folder per
 * set, named after what it installs, in which npm installs them and they are bundled.
 */
const EXTENSIONS_DIR = "extensions";

/**
 * Pi's agent directory for the extensions, in the Runner's data directory, which they are told of as
 * Pi tells extensions (`PI_CODING_AGENT_DIR`): where they read their settings, such as
 * pi-web-access's `web-search.json`, kept apart from the Runner's own files.
 */
const PI_AGENT_DIR = "pi-agent";

/**
 * The parts of an extensions folder that are not what npm installs: what an earlier install left
 * there, and the extensions' settings, which change without a new install.
 */
const NOT_INSTALLED = new Set(["node_modules", PI_AGENT_DIR]);

const ExtensionsManifest = Schema.fromJsonString(
  Schema.Struct({ dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
);

/**
 * pi-web-access's tools that take a proxy URL, `proxy`, which it checks for its scheme only, so a
 * model could route their requests through any host, past its guard against private addresses, and
 * `""` past a proxy the operator configured. Checked on each upgrade of the pinned version.
 */
const PROXY_TOOLS = new Set(["web_search", "fetch_content", "source_check"]);

/**
 * Refuses a call to one of pi-web-access's tools that names a proxy, telling the model to leave it
 * out; a proxy the operator configures for the extension still applies. A tool renamed in the
 * extension's settings (`toolNames`) is not recognised.
 */
export const webAccessProxyGuard = hook(ToolTask, {
  beforeTool: (call) =>
    PROXY_TOOLS.has(call.name) && call.arguments["proxy"] !== undefined
      ? { block: "Choosing a proxy is not allowed here: call the tool without `proxy`." }
      : undefined,
});

/** An extension the Runner was told to load could not be installed or bundled. */
export class ExtensionsUnavailable extends Data.TaggedError("ExtensionsUnavailable")<{
  message: string;
}> {}

/**
 * Installs and bundles the extensions in `folder`, an npm project that lists them as dependencies
 * with its `package-lock.json`, as the Runner starts, and gives them its `pi-agent` folder as their
 * settings.
 *
 * npm installs the set once, with `npm ci`, which installs exactly the lockfile's versions and
 * checks each package's hash, into a folder of the data directory named after the set, so a Runner
 * restarted with the same set starts without the registry, and a changed set installs beside
 * nothing: earlier sets are removed. The folder is copied first, so it may be read-only and local
 * packages inside it keep their relative paths. The settings are copied at every start, so the
 * folder stays their only source; what extensions wrote in their agent directory does not survive a
 * restart. Fails, naming each extension and why, when any cannot be installed or bundled: a Runner
 * whose jobs lack an extension it was told to load would fail them in ways the operator never sees.
 */
export function prepareRunnerExtensions(
  dataDir: string,
  folder: string | undefined,
): Effect.Effect<PreparedExtensions | undefined, ExtensionsUnavailable> {
  if (folder === undefined) return Effect.succeed(undefined);
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const source = path.resolve(folder);
    const manifest = yield* fs.readFileString(path.join(source, "package.json")).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ExtensionsManifest)),
      Effect.mapError((error) => unavailable(`${source}/package.json cannot be read`, error)),
    );
    const names = Object.keys(manifest.dependencies ?? {});
    const agentDir = path.resolve(dataDir, PI_AGENT_DIR);
    yield* copySettings(source, agentDir).pipe(
      Effect.mapError((error) => unavailable("Their settings cannot be copied", error)),
    );
    if (names.length === 0) return undefined;
    if (
      !(yield* fs
        .exists(path.join(source, "package-lock.json"))
        .pipe(Effect.orElseSucceed(() => false)))
    )
      return yield* new ExtensionsUnavailable({
        message: `${source} has no package-lock.json, which pins what npm installs; make it there with \`npm install --package-lock-only\``,
      });
    const installed = yield* install(source, path.resolve(dataDir, EXTENSIONS_DIR));
    const sourceOf = new Map(
      names.map((name) => [path.join(installed, "node_modules", name), name]),
    );
    const prepared = yield* Effect.tryPromise({
      try: (signal) =>
        prepareExtensions({
          sources: [...sourceOf.keys()],
          dir: path.join(installed, "prepared"),
          signal,
        }),
      catch: (error) => unavailable("The extensions cannot be prepared", error),
    });
    if (prepared.failures.length > 0) {
      return yield* new ExtensionsUnavailable({
        message: `These extensions cannot be prepared: ${describeFailures(
          prepared.failures.map((failure) => ({
            ...failure,
            source: sourceOf.get(failure.source) ?? failure.source,
          })),
        )}`,
      });
    }
    return prepared;
  }).pipe(Effect.provide(NodeServices));
}

/**
 * Installs the npm project in `source` into a folder of `dir` named after its files, unless an
 * earlier start installed the same set, and removes every other set there. Returns the folder.
 */
function install(source: string, dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const installed = path.join(dir, yield* setName(source));
    yield* fs.makeDirectory(dir, { recursive: true });
    // Earlier sets, and an install a stop interrupted, which never got its final name.
    for (const entry of yield* fs.readDirectory(dir)) {
      if (path.join(dir, entry) !== installed)
        yield* fs.remove(path.join(dir, entry), { recursive: true });
    }
    if (yield* fs.exists(installed)) return installed;
    const partial = `${installed}.partial`;
    yield* fs.copy(source, partial);
    for (const entry of NOT_INSTALLED)
      yield* fs.remove(path.join(partial, entry), { recursive: true, force: true });
    // Pi supplies its own packages to extensions, which declare them as peers; as when Pi installs
    // a package, npm does not install them (the folder's `.npmrc` says so too, for the lockfile).
    const { failure } = yield* runCommand(
      ChildProcess.make("npm", ["ci", "--legacy-peer-deps", "--no-audit", "--no-fund"], {
        cwd: partial,
      }),
    );
    if (failure !== undefined)
      return yield* new ExtensionsUnavailable({
        message: `npm could not install the extensions: ${failure}`,
      });
    yield* fs.rename(partial, installed);
    return installed;
  }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(unavailable("The extensions cannot be installed", error)),
    ),
  );
}

/** A name for the set the npm project in `source` installs: a hash of its files. */
function setName(source: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const hash = createHash("sha256");
    const entries = (yield* fs.readDirectory(source, { recursive: true }))
      .filter((entry) => !NOT_INSTALLED.has(entry.split(path.sep)[0] ?? ""))
      .toSorted();
    for (const entry of entries) {
      const file = path.join(source, entry);
      if ((yield* fs.stat(file)).type !== "File") continue;
      hash
        .update(`${entry}\0`)
        .update(yield* fs.readFile(file))
        .update("\0");
    }
    return hash.digest("hex").slice(0, 16);
  });
}

/** Replaces the extensions' agent directory with a copy of the `pi-agent` folder in `source`, if any. */
function copySettings(source: string, agentDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(agentDir, { recursive: true, force: true });
    const settings = path.join(source, PI_AGENT_DIR);
    if (yield* fs.exists(settings)) yield* fs.copy(settings, agentDir);
    else yield* fs.makeDirectory(agentDir, { recursive: true });
  });
}

function unavailable(what: string, error: unknown) {
  return new ExtensionsUnavailable({ message: `${what}: ${ensureError(error).message}` });
}

/** Each extension that failed, and why, in one line. */
export function describeFailures(failures: readonly { source: string; message: string }[]) {
  return failures.map(({ source, message }) => `${source}: ${message}`).join("; ");
}

/**
 * Runs `prepared`'s extensions for the Runner's jobs until the scope closes, which closes every
 * job's extensions still attached and stops their workers.
 */
export function startRunnerExtensions(dataDir: string, prepared: PreparedExtensions) {
  const agentDir = path.resolve(dataDir, PI_AGENT_DIR);
  return Effect.acquireRelease(
    Effect.sync(() =>
      startExtensionHost({
        prepared,
        // Extensions are the operator's code, as trusted as the Runner: they see its environment.
        workerOptions: {
          env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        },
      }),
    ),
    (host: ExtensionHost) => Effect.promise(() => host.close()),
  );
}
