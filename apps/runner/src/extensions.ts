import path from "node:path";

import { hook, ToolTask } from "@earendil-works/pi-durable";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {
  type ExtensionHost,
  type PreparedExtensions,
  prepareExtensions,
  startExtensionHost,
} from "@elflodge/pi-durable-extension-adapter";
import { Data, Effect, FileSystem } from "effect";
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
 * The search providers pi-web-access may use on a Runner whose operator has not chosen: those that
 * need a key or a URL. The keyless ones (Exa's free endpoint, DuckDuckGo, AnySearch, Keenable,
 * Parallel's MCP endpoint, and degoog's public instance), which the model can pick by name, would
 * send a job's queries to services the operator never chose. Checked on each upgrade of the pinned
 * version, whose providers may change.
 */
const KEYED_SEARCH_PROVIDERS = [
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
];

/**
 * pi-web-access's settings for a Runner whose operator has not written them yet: the keyed search
 * providers, with Exa when the Runner has an Exa key, read from the environment variable by name so
 * that a key that goes missing fails the search rather than fall back to Exa's free endpoint, and
 * degoog when the Runner names its own instance in `DEGOOG_URL`, kept in the file so that the
 * variable going missing does not fall back to degoog's public instance; and
 * video off, since its local files are read from anywhere on the Runner's host.
 */
function defaultWebSearch(env: NodeJS.ProcessEnv) {
  const exa = Boolean(env["EXA_API_KEY"]);
  const degoog = env["DEGOOG_URL"];
  return {
    webSearch: {
      allowedProviders: [
        ...KEYED_SEARCH_PROVIDERS,
        ...(exa ? ["exa"] : []),
        ...(degoog ? ["degoog"] : []),
      ],
    },
    ...(exa ? { exaApiKey: "$EXA_API_KEY" } : {}),
    ...(degoog ? { degoogBaseUrl: degoog } : {}),
    video: { enabled: false },
  };
}

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
 * Installs and bundles `sources` in the data directory, as the Runner starts, and writes
 * pi-web-access's settings there when they are missing. Pi installs a pinned npm source once and
 * reuses it while the source stays the same, so a Runner that restarts without reaching the
 * registry still loads it. Fails, naming each source and why, when any cannot be installed or
 * bundled: a Runner whose jobs lack an extension it was told to load would fail them in ways the
 * operator never sees.
 */
export function prepareRunnerExtensions(
  dataDir: string,
  sources: readonly string[],
): Effect.Effect<PreparedExtensions | undefined, ExtensionsUnavailable> {
  if (sources.length === 0) return Effect.succeed(undefined);
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const agentDir = path.resolve(dataDir, PI_AGENT_DIR);
    yield* fs.makeDirectory(agentDir, { recursive: true }).pipe(Effect.mapError(unprepared));
    // Written only when absent: from then on the file is the operator's.
    yield* fs
      .writeFileString(
        path.join(agentDir, "web-search.json"),
        `${JSON.stringify(defaultWebSearch(process.env), null, 2)}\n`,
        { flag: "wx" },
      )
      .pipe(
        Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.void),
        Effect.mapError(unprepared),
      );
    const prepared = yield* Effect.tryPromise({
      try: (signal) =>
        prepareExtensions({
          sources: [...sources],
          dir: path.resolve(dataDir, EXTENSIONS_DIR),
          signal,
        }),
      catch: unprepared,
    });
    if (prepared.failures.length > 0) {
      return yield* new ExtensionsUnavailable({
        message: `These extensions could not be prepared: ${describeFailures(prepared.failures)}`,
      });
    }
    return prepared;
  }).pipe(Effect.provide(NodeFileSystem.layer));
}

function unprepared(error: unknown) {
  return new ExtensionsUnavailable({
    message: `The extensions could not be prepared: ${ensureError(error).message}`,
  });
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
