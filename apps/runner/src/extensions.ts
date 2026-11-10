import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type ExtensionHost,
  type PreparedExtensions,
  prepareExtensions,
  startExtensionHost,
} from "@elflodge/pi-durable-extension-adapter";
import { Data, Effect } from "effect";
import ensureError from "ensure-error";

// Pi coding-agent extensions in jobs, through `@elflodge/pi-durable-extension-adapter` (ADR 0038):
// installed and bundled once as the Runner starts, run in a few worker threads the Runner's jobs
// share, and attached to each job's conversation while its agent runs.

/** The directory in the Runner's data directory where Pi installs extensions and they are bundled. */
const EXTENSIONS_DIR = "extensions";

/**
 * Pi's agent directory for the extensions, in the Runner's data directory, which they are told of as
 * Pi tells extensions (`PI_CODING_AGENT_DIR`): where pi-web-access reads its `web-search.json`, kept
 * apart from the Runner's own files.
 */
const PI_AGENT_DIR = "pi-agent";

/**
 * pi-web-access's settings for a Runner whose operator has not written them yet, which the Runner
 * writes once: jobs search only through providers given a key, since the keyless ones, which the
 * model can pick by name, send the job's queries to services the operator never chose; and video is
 * off, since its local files are read from anywhere on the Runner's host. Checked on each upgrade of
 * the pinned version, whose providers may change.
 */
const DEFAULT_WEB_SEARCH = {
  webSearch: {
    allowedProviders: [
      "openai",
      "brave",
      "parallel",
      "tinyfish",
      "search1api",
      "searchinfinity",
      "querit",
      "tavily",
      "you",
      "firecrawl",
      "jina",
      "searxng",
      "degoog",
      "perplexity",
      "gemini",
      "kimi",
      "serpdive",
      "kagi",
      "ollama",
      "xai",
      "mistral",
      "brightdata",
      "serpbase",
      "serpapi",
      "serper",
      "serply",
      "valyu",
      "bocha",
      "xcrawl",
      "baizhi",
      "zai",
      "ceramic",
      "deepseek",
      "linkup",
      "ninerouter",
      "cloudflare",
      "searchapi",
      "outcrawl",
      "sofya",
      "tabstack",
    ],
  },
  video: { enabled: false },
};

/** An extension the Runner was told to load could not be installed or bundled. */
export class ExtensionsUnavailable extends Data.TaggedError("ExtensionsUnavailable")<{
  message: string;
}> {}

/**
 * Installs and bundles `sources` in the data directory, as the Runner starts. Pi installs a pinned
 * npm source once and reuses it while the source stays the same, so a Runner that restarts without
 * reaching the registry still loads it. Fails, naming each source and why, when any cannot be
 * installed or bundled: a Runner whose jobs lack an extension it was told to load would fail them
 * in ways the operator never sees.
 */
export function prepareRunnerExtensions(
  dataDir: string,
  sources: readonly string[],
): Effect.Effect<PreparedExtensions | undefined, ExtensionsUnavailable> {
  if (sources.length === 0) return Effect.succeed(undefined);
  return Effect.tryPromise({
    try: async (signal) => {
      const agentDir = path.resolve(dataDir, PI_AGENT_DIR);
      await mkdir(agentDir, { recursive: true });
      // Written only when absent: from then on the file is the operator's.
      await writeFile(
        path.join(agentDir, "web-search.json"),
        `${JSON.stringify(DEFAULT_WEB_SEARCH, null, 2)}\n`,
        { flag: "wx" },
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      return prepareExtensions({
        sources: [...sources],
        dir: path.resolve(dataDir, EXTENSIONS_DIR),
        signal,
      });
    },
    catch: (error) =>
      new ExtensionsUnavailable({
        message: `The extensions could not be prepared: ${ensureError(error).message}`,
      }),
  }).pipe(
    Effect.flatMap((prepared) =>
      prepared.failures.length === 0
        ? Effect.succeed(prepared)
        : Effect.fail(
            new ExtensionsUnavailable({
              message: `These extensions could not be prepared: ${prepared.failures
                .map(({ source, message }) => `${source}: ${message}`)
                .join("; ")}`,
            }),
          ),
    ),
  );
}

/**
 * Runs `prepared`'s extensions for the Runner's jobs until the scope closes, which closes every
 * job's extensions still attached and stops their workers.
 */
export function startRunnerExtensions(dataDir: string, prepared: PreparedExtensions) {
  return Effect.acquireRelease(
    Effect.sync(() =>
      startExtensionHost({
        prepared,
        // Extensions are the operator's code, as trusted as the Runner: they see its environment.
        workerOptions: {
          env: { ...process.env, PI_CODING_AGENT_DIR: path.resolve(dataDir, PI_AGENT_DIR) },
        },
      }),
    ),
    (host: ExtensionHost) => Effect.promise(() => host.close()),
  );
}
