import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { build, type Plugin } from "rolldown";

// Runs in the worker `prepareExtensions` starts. Installing goes through Pi's package manager, so
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
 * `pi-ai/compat` registering every built-in provider, which esbuild keeps.
 */
const PI_MODULES = /[\\/]node_modules[\\/](@earendil-works[\\/]pi-(ai|agent-core|coding-agent|tui)|typebox)[\\/]/;

/**
 * What Pi's loader gives an extension that imports pi-ai's root or `pi-ai/compat`: the compat entry
 * point plus TypeBox's `Type` and a `StringEnum`, which pi-ai's root no longer exports. Pi builds it
 * in a file of its own (`pi-ai-extension-view.js`) that its package does not export, so the bundle
 * builds the same module.
 */
const PI_AI_VIEW = "\0pi-ai-extension-view";
const PI_AI_VIEW_SOURCE = `import { Type } from "typebox";
export * from "@earendil-works/pi-ai/compat";
export { Type };
export function StringEnum(values, options) {
  return Type.Unsafe({
    type: "string",
    enum: values,
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default }),
  });
}
`;

/** This package's runtime, built into the bundle with the extensions (`.ts` from source, `.mjs` built). */
const runtimeModule = fileURLToPath(
  new URL(`./runtime${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);

/** The coding agent's entry, from which the packages Pi supplies resolve to its own dependencies. */
const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));

interface Input {
  sources: string[];
  dir: string;
}

async function prepare({ sources, dir }: Input) {
  const settingsManager = SettingsManager.inMemory();
  const packages = new DefaultPackageManager({ cwd: dir, agentDir: dir, settingsManager });
  const resolved = await packages.resolveExtensionSources(sources);
  const found = resolved.extensions
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
 * Bundles `found`, with this package's runtime, into one build under `<dir>/bundles/<key>`, with
 * code splitting, so what the extensions and the runtime share of Pi loads once per worker and an
 * extension's own dynamic imports stay lazy. The key covers each extension's file and its
 * package's manifest, so a new version builds again and an unchanged set reuses the last build.
 * When the combined build fails, each extension is tried with the runtime alone, and the build is
 * made of those that pass; the others are failures, as loading one unbundled would need Pi's
 * TypeScript loader and its whole coding agent in every worker.
 */
async function bundle(found: { source: string; path: string }[], dir: string): Promise<Bundle> {
  const key = await bundleKey(found);
  const outDir = path.join(dir, "bundles", key);
  const manifestPath = path.join(outDir, "manifest.json");
  const cached = await readFile(manifestPath, "utf8").then(
    (text): unknown => JSON.parse(text),
    () => undefined,
  );
  if (isBundle(cached)) return cached;
  await rm(outDir, { recursive: true, force: true });
  const failures: { source: string; message: string }[] = [];
  let included = found;
  try {
    await buildEntries(entries(included), outDir);
  } catch {
    included = [];
    for (const each of found) {
      const trial = path.join(dir, "bundles", `${key}-trial`);
      try {
        await buildEntries(entries([each]), trial);
        included.push(each);
      } catch (error) {
        failures.push({ source: each.source, message: `Bundling failed: ${errorMessage(error)}` });
      } finally {
        await rm(trial, { recursive: true, force: true });
      }
    }
    await buildEntries(entries(included), outDir);
  }
  const result: Bundle = {
    runtime: path.join(outDir, "runtime.mjs"),
    extensions: included.map((each, index) => ({
      source: each.source,
      path: path.join(outDir, `extension-${index}.mjs`),
    })),
    failures,
  };
  await mkdir(outDir, { recursive: true });
  // ES modules, so Node reads the chunks as such whatever the directory above says.
  await writeFile(path.join(outDir, "package.json"), '{"type":"module"}\n');
  await writeFile(manifestPath, `${JSON.stringify(result)}\n`);
  return result;
}

interface Bundle {
  runtime: string;
  extensions: { source: string; path: string }[];
  failures: { source: string; message: string }[];
}

function isBundle(value: unknown): value is Bundle {
  return typeof value === "object" && value !== null && "runtime" in value && "extensions" in value;
}

/** The build's entries: the runtime, then each extension in load order. */
function entries(found: { path: string }[]) {
  return {
    runtime: runtimeModule,
    ...Object.fromEntries(found.map((each, index) => [`extension-${index}`, each.path])),
  };
}

function errorMessage(error: unknown) {
  if (typeof error === "object" && error !== null && "errors" in error && Array.isArray(error.errors)) {
    return error.errors.map((each: unknown) => (each instanceof Error ? each.message : String(each))).join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}

async function buildEntries(input: Record<string, string>, outDir: string) {
  await build({
    input,
    platform: "node",
    logLevel: "silent",
    plugins: [hostPackages()],
    treeshake: { moduleSideEffects: (id) => !PI_MODULES.test(id) },
    output: {
      dir: outDir,
      format: "esm",
      entryFileNames: "[name].mjs",
      chunkFileNames: "chunks/[name]-[hash].mjs",
      // Bundled CommonJS dependencies call `require`, which an ES module lacks.
      banner: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  });
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
      if (!HOST_PACKAGES.test(source) || importer === codingAgentEntry) return null;
      const name = source
        .replace(/^@mariozechner\//, "@earendil-works/")
        .replace(/^@sinclair\/typebox/, "typebox");
      const fromExtension = importer !== PI_AI_VIEW && !(importer && PI_MODULES.test(importer));
      if (fromExtension && /^@earendil-works\/pi-ai(?:\/compat)?$/.test(name)) return PI_AI_VIEW;
      return this.resolve(name, codingAgentEntry, { ...extraOptions, skipSelf: true });
    },
    load(id) {
      return id === PI_AI_VIEW ? PI_AI_VIEW_SOURCE : null;
    },
  };
}

async function bundleKey(found: { source: string; path: string }[]) {
  const hash = createHash("sha256");
  for (const each of found) {
    hash.update(each.path);
    hash.update("\0");
    hash.update(await packageManifest(each.path));
    hash.update("\0");
  }
  hash.update(await readFile(path.join(path.dirname(codingAgentEntry), "..", "package.json")));
  return hash.digest("hex").slice(0, 16);
}

/** The nearest `package.json` above `file`, or nothing for a file outside any package. */
async function packageManifest(file: string): Promise<string> {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const text = await readFile(path.join(dir, "package.json"), "utf8").catch(() => undefined);
    if (text !== undefined) return text;
    if (path.dirname(dir) === dir) return "";
  }
}

const input: Input = workerData;
prepare(input).then(
  (result) => parentPort?.postMessage(result),
  (error: unknown) =>
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) }),
);
