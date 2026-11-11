import path from "node:path";

import { hook, ToolTask } from "@earendil-works/pi-durable";
import {
  type ExtensionHost,
  type PreparedExtensions,
  prepareExtensions,
  startExtensionHost,
} from "@elflodge/pi-durable-extension-adapter";
import { Data, Effect, FileSystem, Option, Path, Schema } from "effect";
import { ChildProcess } from "effect/process";
import ensureError from "ensure-error";
import { hashElement } from "folder-hash";

import { NodeServices, runCommand } from "./sandbox.ts";

// Pi coding-agent extensions in jobs, through `@elflodge/pi-durable-extension-adapter` (ADR 0038):
// installed and bundled once as the Runner starts, run in a few worker threads the Runner's jobs
// share, and attached to each job's conversation while its agent runs.

/**
 * The directory in the Runner's data directory that holds the installed extensions: one folder per
 * set, named after what it installs, which holds the npm project npm installs them in, and what the
 * adapter writes as it bundles them (its `bundle` folder).
 */
const EXTENSIONS_DIR = "extensions";

/**
 * The folder of an installed set that holds the copy of the operator's npm project, apart from the
 * adapter's own output, which would otherwise replace a local package at the same path.
 */
const PROJECT_DIR = "project";

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
 * `""` past a proxy the operator configured. Its `lockProxy` setting stops that only where a proxy
 * is configured: without one it fails every call. Checked on each upgrade of the pinned version.
 */
const PROXY_TOOLS = new Set(["web_search", "fetch_content", "source_check"]);

/**
 * Refuses a call to pi-web-access's tools that names a proxy, telling the model to leave it out; a
 * proxy the operator configures for the extension still applies. Also refuses a search that asks for
 * a summary (`workflow` other than `none`), which pi-web-access writes with a model through the
 * Runner's credentials, outside the job's budget, and one that names the search provider's model
 * (`model`): the operator's settings choose both, and the model may not spend beyond them. A tool
 * renamed in the extension's settings (`toolNames`) is
 * not recognised.
 */
export const webAccessGuard = hook(ToolTask, {
  beforeTool: (call) => {
    if (PROXY_TOOLS.has(call.name) && call.arguments["proxy"] !== undefined)
      return { block: "Choosing a proxy is not allowed here: call the tool without `proxy`." };
    const workflow = call.arguments["workflow"];
    if (call.name === "web_search" && workflow !== undefined && workflow !== "none")
      return { block: "Search summaries are not allowed here: call the tool without `workflow`." };
    if (call.name === "web_search" && call.arguments["model"] !== undefined)
      return {
        block: "Choosing the search model is not allowed here: call the tool without `model`.",
      };
    return undefined;
  },
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
    const paths = yield* Path.Path;
    // The Runner replaces what it keeps in its data directory, so a folder there, or one holding
    // it, would lose its files or be copied with the data; their real paths, as a symbolic link
    // could hide either inside the other.
    const source = yield* fs
      .realPath(folder)
      .pipe(Effect.mapError((error) => unavailable(`${folder} cannot be read`, error)));
    const data = yield* fs.makeDirectory(dataDir, { recursive: true }).pipe(
      Effect.andThen(fs.realPath(dataDir)),
      Effect.mapError((error) => unavailable(`${dataDir} cannot be read`, error)),
    );
    const contains = (parent: string, child: string) =>
      Option.isSome(paths.resolveWithin(parent, paths.relative(parent, child)));
    if (contains(source, data) || contains(data, source))
      return yield* new ExtensionsUnavailable({
        message: `The extensions folder ${source} and RUNNER_DATA_DIR ${data} must not contain one another`,
      });
    const manifest = yield* fs.readFileString(path.join(source, "package.json")).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ExtensionsManifest)),
      Effect.mapError((error) => unavailable(`${source}/package.json cannot be read`, error)),
    );
    const names = Object.keys(manifest.dependencies ?? {});
    yield* replaceSettings(source, path.resolve(dataDir, PI_AGENT_DIR)).pipe(
      Effect.mapError((error) => unavailable("Their settings cannot be copied", error)),
    );
    if (names.length === 0) return undefined;
    const installed = yield* installReplacingOthers(source, path.resolve(dataDir, EXTENSIONS_DIR));
    const sourceOf = new Map(
      names.map((name) => [path.join(installed, PROJECT_DIR, "node_modules", name), name]),
    );
    const prepared = yield* Effect.tryPromise({
      try: (signal) =>
        prepareExtensions({
          sources: [...sourceOf.keys()],
          // Their bundled entries are written beside their sources, inside `dir`, so files a package
          // reads relative to itself are where it looks; the adapter's own output goes beside the
          // project.
          dir: installed,
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
 * Installs the npm project in `source` into a folder of `dir` named after it, in its `project`
 * folder, unless an earlier start installed the same set, and removes every other folder there.
 * Returns the folder.
 */
function installReplacingOthers(source: string, dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const installed = path.join(dir, yield* installKey(source));
    yield* fs.makeDirectory(dir, { recursive: true });
    // Earlier sets, and an install a stop interrupted, which never got its final name.
    for (const entry of yield* fs.readDirectory(dir)) {
      if (path.join(dir, entry) !== installed)
        yield* fs.remove(path.join(dir, entry), { recursive: true });
    }
    if (yield* fs.exists(installed)) return installed;
    const partial = `${installed}.partial`;
    const project = path.join(partial, PROJECT_DIR);
    yield* fs.copy(source, project);
    for (const entry of NOT_INSTALLED)
      yield* fs.remove(path.join(project, entry), { recursive: true, force: true });
    // As Pi installs a package: without its development dependencies, nor the Pi packages
    // extensions declare as peers, which Pi supplies (the folder's `.npmrc` says so too, for the
    // lockfile). npm ci refuses a folder without a lockfile, naming it.
    const { failure } = yield* runCommand(
      ChildProcess.make(
        "npm",
        ["ci", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"],
        { cwd: project },
      ),
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

/**
 * What identifies the set the npm project in `source` installs: a hash of its files, and the Node
 * ABI and platform its native add-ons were built for, so a Runner on another Node installs afresh.
 */
function installKey(source: string) {
  // The folders the install leaves out, at the top only, as a local package may hold its own.
  // folder-hash documents a function of the path here; its types declare another, which the patch
  // in `patches/` corrects.
  const left = new Set([...NOT_INSTALLED].map((entry) => path.join(source, entry)));
  return Effect.tryPromise({
    try: () =>
      hashElement(source, {
        algo: "sha256",
        encoding: "hex",
        folders: {
          exclude: (folder) => left.has(folder),
          matchBasename: false,
          matchPath: true,
          ignoreRootName: true,
        },
        files: { ignoreRootName: true },
      }),
    catch: (error) => unavailable("The extensions folder cannot be read", error),
  }).pipe(
    Effect.map(
      ({ hash }) =>
        `${hash.slice(0, 16)}-node${process.versions.modules}-${process.platform}-${process.arch}`,
    ),
  );
}

/** Replaces the extensions' agent directory with a copy of the `pi-agent` folder in `source`, if any. */
function replaceSettings(source: string, agentDir: string) {
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
