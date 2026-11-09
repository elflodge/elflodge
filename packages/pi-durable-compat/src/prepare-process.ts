import { existsSync } from "node:fs";
import { glob, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import ensureError from "ensure-error";
import { build, type OutputChunk, type Plugin } from "rolldown";

import type { PreparedExtension, PreparedExtensions } from "./prepare.ts";

// Runs in the child process `prepareExtensions` starts. Installing goes through Pi's package manager, so
// sources, pinning, peer handling and resource discovery behave as `pi install` does; bundling goes
// through Rolldown, the bundler Pi's plugin runtime and our own toolchain build on.

/**
 * The packages Pi supplies to extensions, which extensions declare as peers and never install
 * (Pi's packages.md, "Declare dependencies"), under their current and former names. The bundle
 * takes them from this package's own copy of the coding agent, as Pi supplies its own, so every
 * extension runs on the versions this package was tested with.
 */
const HOST_PACKAGES =
  /^(?:@(?:earendil-works|mariozechner)\/pi-(?:ai|agent-core|coding-agent|tui)|typebox|@sinclair\/typebox)(?:\/.*)?$/;

/**
 * Pi's packages declare no `sideEffects` (pi-ai declares a list), so a bundler must keep every module
 * their entry points re-export. Treating them as side-effect free lets Rolldown keep only what an
 * extension uses: the coding agent's root alone costs about 80 MiB per worker, the parts the search
 * extensions use about 15. Rolldown also drops unused statements inside a module, such as
 * `pi-ai/compat` registering every built-in provider, which esbuild keeps; an extension that calls
 * a model through pi-ai keeps it.
 */
const PI_MODULES =
  /[\\/]node_modules[\\/](@earendil-works[\\/]pi-(ai|agent-core|coding-agent|tui)|typebox)[\\/]/;

/**
 * The modules of Pi's packages whose import does work other modules depend on, which the build
 * keeps whenever it keeps anything that imports them: pi-ai's image providers register themselves,
 * and the coding agent's entry with `core/sdk.js` sets the stream function an `Agent` created
 * without one uses. Found by listing every import-time statement in Pi 1.5's modules; the others
 * fill registries or caches no extension reads unless it imports them itself.
 */
const PI_INITIALIZERS =
  /[\\/]node_modules[\\/]@earendil-works[\\/](pi-ai[\\/]dist[\\/]providers[\\/]images[\\/]register-builtins|pi-coding-agent[\\/]dist[\\/](index|core[\\/]sdk))\.js$/;

/** This package's runtime, built into the bundle with the extensions (`.ts` from source, `.mjs` built). */
const runtimeModule = fileURLToPath(
  new URL(`./runtime${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);

/** The coding agent's entry, from which the packages Pi supplies resolve to its own dependencies. */
const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));

/**
 * Pi's extension loader, which the runtime imports as `pi-extension-loader` to build each
 * extension's `pi` as Pi does; the coding agent does not export it.
 */
const PI_LOADER = "pi-extension-loader";
const piLoader = path.join(path.dirname(codingAgentEntry), "core", "extensions", "loader.js");

/**
 * What Pi's loader gives an extension that imports pi-ai's root or `pi-ai/compat`: the compat entry
 * point plus TypeBox's `Type` and a `StringEnum`, which pi-ai's root no longer exports. Reached by
 * its path beside the loader, which the coding agent does not export either.
 */
const piAiView = path.join(
  path.dirname(codingAgentEntry),
  "core",
  "extensions",
  "pi-ai-extension-view.js",
);

/** How an extension's entry is named beside its source. */
const ENTRY_SUFFIX = ".pi-durable-compat.mjs";

/** A native add-on. */
const ADDON = /\.node$/;

/**
 * Packages that load a file of their own from beside their code, which stay where they are
 * installed rather than move into the bundle: Photon, Pi's image library, reads its WebAssembly
 * next to its module.
 */
const LEFT_INSTALLED = /[\\/]node_modules[\\/]@silvia-odwyer[\\/]photon-node[\\/]/;

interface Input {
  sources: string[];
  dir: string;
}

async function prepare({ sources, dir }: Input): Promise<PreparedExtensions> {
  const settingsManager = SettingsManager.inMemory();
  const packages = new DefaultPackageManager({ cwd: dir, agentDir: dir, settingsManager });
  const resolved = await packages.resolveExtensionSources(sources);
  const found: PreparedExtension[] = resolved.extensions
    .filter((each) => each.enabled)
    .map((each) => ({ source: each.metadata.source, path: each.path }));
  const failures = (resolved.installFailures ?? []).map(({ source, message }) => ({
    source,
    message,
  }));
  const bundled = await bundle(found, dir);
  return { ...bundled, failures: [...failures, ...bundled.failures] };
}

/**
 * Bundles `found`, with this package's runtime, into one build, with code splitting, so what the
 * extensions and the runtime share of Pi loads once per worker and an extension's own dynamic
 * imports stay lazy. The entry of each extension installed in `dir` is written beside its source, as
 * `<name>.pi-durable-compat.mjs`, so the files a package reads relative to it (`package.json`,
 * templates, WebAssembly) are where it looks; the runtime, extensions from local paths outside `dir`
 * and the shared chunks go in `<dir>/bundle`.
 * It builds on every call, in about a second, so no change to an extension, to Pi or to this package
 * can leave an old build in use. When the combined build fails, each extension is tried with the
 * runtime alone, without writing, and the build is made of those that pass; the others are failures.
 */
async function bundle(found: PreparedExtension[], dir: string): Promise<PreparedExtensions> {
  const outDir = path.join(dir, "bundle");
  await rm(outDir, { recursive: true, force: true });
  for await (const stale of glob(`**/*${ENTRY_SUFFIX}`, { cwd: dir })) {
    await rm(path.join(dir, stale), { force: true });
  }
  const failures: { source: string; message: string }[] = [];
  let included = found;
  let built: Built;
  try {
    built = await buildEntries(entries(included), dir);
  } catch {
    included = [];
    for (const each of found) {
      try {
        await buildEntries(entries([each]), dir, false);
        included.push(each);
      } catch (error) {
        failures.push({ source: each.source, message: `Bundling failed: ${errorMessage(error)}` });
      }
    }
    built = await buildEntries(entries(included), dir);
  }
  const file = (name: string) => {
    const chunk = built.chunks.find((each) => each.isEntry && each.name === name);
    if (!chunk) throw new Error(`The build has no entry ${name}`);
    return path.join(dir, chunk.fileName);
  };
  return {
    runtime: file("runtime"),
    extensions: included.map((each, index) => ({
      source: each.source,
      path: file(`extension-${index}`),
    })),
    addons: built.addons,
    failures,
  };
}

/** The build's entries: the runtime, then each extension in load order. */
function entries(found: { path: string }[]) {
  return {
    runtime: runtimeModule,
    ...Object.fromEntries(found.map((each, index) => [`extension-${index}`, each.path])),
  };
}

/** Rolldown's build error lists each failure; other errors have their message. */
function errorMessage(error: unknown) {
  const ensured = ensureError(error);
  if (!("errors" in ensured) || !Array.isArray(ensured.errors)) return ensured.message;
  return ensured.errors.map((each: unknown) => ensureError(each).message).join("\n");
}

interface Built {
  chunks: OutputChunk[];
  /** The native add-ons the build leaves to load from where they are installed. */
  addons: string[];
}

async function buildEntries(
  input: Record<string, string>,
  dir: string,
  write = true,
): Promise<Built> {
  const addons: string[] = [];
  const { output } = await build({
    input,
    platform: "node",
    logLevel: "silent",
    write,
    plugins: [hostPackages(), externalAddons(addons)],
    // Native add-ons load from where they are installed (see `externalAddons`), and the host
    // loads each in its main thread too (see `startExtensionHost`). `LEFT_INSTALLED` packages
    // also load from where they are installed.
    external: (id, _importer, resolved) => resolved && (ADDON.test(id) || LEFT_INSTALLED.test(id)),
    makeAbsoluteExternalsRelative: false,
    transform: {
      define: {
        // CommonJS code bundled into ES modules has no `__dirname`; with each entry beside its
        // source, the module's own directory stands in for it.
        __dirname: "import.meta.dirname",
        __filename: "import.meta.filename",
        // Pi looks for its own files, its `package.json` with its version among them, above its
        // code, which the bundle moves; `PI_PACKAGE_DIR` is its documented way to say where they
        // are, set here rather than in the workers' environment, which commands inherit.
        "process.env.PI_PACKAGE_DIR": JSON.stringify(path.dirname(path.dirname(codingAgentEntry))),
      },
    },
    treeshake: { moduleSideEffects: (id) => !PI_MODULES.test(id) || PI_INITIALIZERS.test(id) },
    output: {
      dir,
      format: "esm",
      entryFileNames: (chunk) => {
        const source = chunk.facadeModuleId;
        if (!source || !isInside(dir, source)) return "bundle/[name].mjs";
        const relative = path.relative(dir, source);
        return relative.slice(0, relative.length - path.extname(relative).length) + ENTRY_SUFFIX;
      },
      chunkFileNames: "bundle/chunks/[name]-[hash].mjs",
      codeSplitting: {
        // TypeBox in a chunk of its own: left where Rolldown puts it, it can share a chunk with an
        // extension module that awaits at top level a module importing TypeBox back, and the
        // two wait on each other (pi-mcp-adapter).
        groups: [{ name: "typebox", test: /[\\/]node_modules[\\/]typebox[\\/]/ }],
      },
    },
  });
  return { chunks: output.filter((each): each is OutputChunk => each.type === "chunk"), addons };
}

/**
 * Leaves native add-ons external by absolute path, since the code that loads them moves, and
 * collects into `addons` those that exist: a package names an add-on for every platform it
 * supports, and only this platform's is installed. One a package reaches by name resolves to its
 * path before the `external` option sees it; one named by a relative path is resolved here.
 */
function externalAddons(addons: string[]): Plugin {
  return {
    name: "pi-external-addons",
    resolveId(source, importer) {
      if (!ADDON.test(source) || !importer || !source.startsWith(".")) return null;
      return { id: path.resolve(path.dirname(importer), source), external: true };
    },
    buildEnd() {
      for (const id of this.getModuleIds()) {
        if (ADDON.test(id) && path.isAbsolute(id) && existsSync(id)) addons.push(id);
      }
    },
  };
}

function isInside(dir: string, file: string) {
  const relative = path.relative(dir, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Resolves the packages Pi supplies from this package's coding agent, wherever an extension imports
 * them, as Pi's loader aliases them: former names to current ones, and pi-ai's root and compat
 * entry to the extension view. Pi's own modules import pi-ai itself.
 */
function hostPackages(): Plugin {
  return {
    name: "pi-host-packages",
    async resolveId(source, importer, extraOptions) {
      if (source === PI_LOADER) return piLoader;
      if (!HOST_PACKAGES.test(source) || importer === codingAgentEntry) return null;
      const name = source
        .replace(/^@mariozechner\//, "@earendil-works/")
        .replace(/^@sinclair\/typebox/, "typebox");
      const fromExtension = !(importer && PI_MODULES.test(importer));
      if (fromExtension && /^@earendil-works\/pi-ai(?:\/compat)?$/.test(name)) return piAiView;
      return this.resolve(name, codingAgentEntry, { ...extraOptions, skipSelf: true });
    },
  };
}

process.once("message", (input: Input) => {
  prepare(input).then(reply, (error: unknown) => reply({ error: ensureError(error).message }));
});

function reply(value: unknown) {
  // The process exits once the reply is sent and the channel closes.
  process.send?.(value, () => process.disconnect());
}
