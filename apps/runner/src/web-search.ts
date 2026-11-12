import type { RunnerCapabilities } from "contract";
import { Array, Option, Predicate, Result, Schema, Struct } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";

// What the Runner reads and changes in pi-web-access's settings file, as of the version the image's
// folder pins: whether web search is on, through which providers, and with which credentials.
// Checked on each upgrade of that version (ADR 0039).

/** The extension package jobs search the web through. */
export const WEB_SEARCH_EXTENSION = "pi-web-access";

/** pi-web-access's settings file in the extensions' agent directory. */
export const WEB_SEARCH_SETTINGS = "web-search.json";

/**
 * The Pi provider whose sign-in is always a ChatGPT subscription, which pi-web-access can search
 * through. Not `openai` signed in with ChatGPT: `login --with-api-key` can replace that sign-in with a
 * key while the Runner runs, and its searches would then be billed to the key until it restarts.
 */
export const CHATGPT_PROVIDER = "openai-codex";

/** pi-web-access's name for search through OpenAI, by a sign-in or a key. */
const OPENAI_SEARCH = "openai";

const TURN_ON =
  "To turn it on, name the providers jobs may use in RUNNER_WEB_SEARCH, such as brave, with their keys in the Runner's environment (apps/runner/README.md).";

type Settings = { readonly [key: string]: unknown };

export interface WebSearchInput {
  /** The settings the extensions would read: the set's defaults, or the operator's own file. */
  readonly settings: Settings;
  /** Whether the operator gave these settings, in the settings folder, rather than the set's defaults. */
  readonly chosen: boolean;
  /** The providers `RUNNER_WEB_SEARCH` names, if it is set. */
  readonly providers: NonEmptyReadonlyArray<string> | undefined;
  /** The jobs' model's provider, when it is a ChatGPT subscription. */
  readonly subscription: string | undefined;
}

export interface WebSearchPlan {
  /** Settings to write in place of the defaults, when the Runner turns search on. */
  readonly settings?: Settings;
  /** What the Runner reports jobs can do with these settings. */
  readonly capability: WebSearchCapability;
  /** What the operator is told as the Runner starts. */
  readonly message: string;
  /** Whether the operator is warned rather than told. */
  readonly warning?: boolean;
}

/**
 * What the Runner does with pi-web-access's settings and says about them, or why it refuses to
 * start. `RUNNER_WEB_SEARCH` and the operator's own file each choose where jobs search, so both
 * together are refused rather than one silently ignored. Without either, search is off, except on a
 * ChatGPT subscription, which searches through itself: no money per search, and queries go to the
 * company that already answers the jobs, as pi-web-access itself does by default.
 */
export function planWebSearch(input: WebSearchInput): Result.Result<WebSearchPlan, string> {
  const { settings, chosen, providers, subscription } = input;
  if (providers !== undefined) {
    if (chosen) {
      return Result.fail(
        "RUNNER_WEB_SEARCH and web-search.json in RUNNER_EXTENSION_SETTINGS_DIR both choose where jobs search: remove one",
      );
    }
    const also =
      subscription !== undefined && !providers.includes(OPENAI_SEARCH)
        ? ` The ChatGPT subscription the model runs on can also search: add ${OPENAI_SEARCH} to RUNNER_WEB_SEARCH.`
        : "";
    return Result.succeed({
      settings: withSearch(settings, providers, subscription),
      capability: {
        enabled: true,
        allowedProviders: [...providers],
        ...(providers.includes(OPENAI_SEARCH)
          ? { openai: { mayUseApiKey: subscription === undefined } }
          : {}),
      },
      message: `Web search is on through ${providers.join(", ")}.${also}`,
    });
  }
  if (!chosen && subscription !== undefined && !isOn(settings)) {
    return Result.succeed({
      settings: withSearch(settings, [OPENAI_SEARCH], subscription),
      capability: {
        enabled: true,
        allowedProviders: [OPENAI_SEARCH],
        openai: { mayUseApiKey: false },
      },
      message: `Web search is on through the ChatGPT subscription the model runs on, and uses its limits. RUNNER_WEB_SEARCH names other providers instead; include ${OPENAI_SEARCH} to keep it.`,
    });
  }
  const source = chosen ? " web-search.json in RUNNER_EXTENSION_SETTINGS_DIR chooses it." : "";
  const capability = describeWebSearch(settings);
  if (!capability.enabled) {
    return Result.succeed({
      capability,
      message: `Web search is off.${chosen ? source : ` ${TURN_ON}`}`,
    });
  }
  const allowed = capability.allowedProviders;
  return Result.succeed(
    allowed === undefined
      ? {
          capability,
          warning: true,
          message:
            "Web search may use any provider pi-web-access finds a key for, keyless ones included: name the providers jobs may use in webSearch.allowedProviders in web-search.json.",
        }
      : { capability, message: `Web search is on through ${allowed.join(", ")}.${source}` },
  );
}

/** What the Runner reports about web search. */
export type WebSearchCapability = NonNullable<RunnerCapabilities["webSearch"]>;

/**
 * The bounds of web search under settings the Runner did not write: whether jobs can search, and
 * the only providers they may reach. Which provider or credential a search uses depends on each
 * search (the job's model may name providers, defaults and routing fall back on failures), so none
 * is predicted. An OpenAI search is reported as possibly billed to a key: only the Runner's own
 * confinement to a ChatGPT subscription rules that out (`planWebSearch`).
 */
export function describeWebSearch(settings: Settings): WebSearchCapability {
  if (!isOn(settings)) return { enabled: false };
  const allowedProviders = providerList(fieldsOf(settings["webSearch"])["allowedProviders"]);
  if (allowedProviders === undefined) return { enabled: true, openai: { mayUseApiKey: true } };
  return {
    enabled: true,
    allowedProviders,
    ...(allowedProviders.includes(OPENAI_SEARCH) ? { openai: { mayUseApiKey: true } } : {}),
  };
}

/** Search providers as pi-web-access reads a list of them: trimmed and lowercased. */
const providerList = (value: unknown) =>
  Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.Array(Schema.String))(value).pipe(
      Option.map((names) => Array.dedupe(names.map((name) => name.trim().toLowerCase()))),
    ),
  );

/**
 * Whether jobs can search, as pi-web-access decides for each of its two searching tools,
 * `web_search` and `source_check`: the tool's own switch, else the shared one, else on. A value
 * that is not a boolean counts as unset, as it does there.
 */
function isOn(settings: Settings) {
  return (["webSearch", "sourceCheck"] as const).some(
    (tool) =>
      flag(fieldsOf(fieldsOf(settings["tools"])[tool])["enabled"]) ??
      flag(fieldsOf(settings["webSearch"])["enabled"]) ??
      true,
  );
}

/** `value`'s fields, or none when it is not an object, as a mistyped setting may be. */
const fieldsOf = (value: unknown): Settings => (Predicate.isObject(value) ? value : {});

const flag = (value: unknown) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Boolean)(value));

/**
 * `settings` with search on through exactly `providers`, tried in that order. pi-web-access's
 * automatic choice skips the providers it calls explicit-only even when they are allowed, so the
 * list is its routing as well as its allowlist; a single default provider would override the
 * routing, so none is kept.
 */
function withSearch(settings: Settings, providers: readonly string[], subscription?: string) {
  const tools = fieldsOf(settings["tools"]);
  const pinned = subscription !== undefined && providers.includes(OPENAI_SEARCH);
  const kept = Struct.omit(
    settings,
    pinned ? ["provider", "searchProvider", "openaiResponsesUrl"] : ["provider", "searchProvider"],
  );
  return {
    ...kept,
    tools: {
      ...tools,
      webSearch: { ...fieldsOf(tools["webSearch"]), enabled: true },
      sourceCheck: { ...fieldsOf(tools["sourceCheck"]), enabled: true },
    },
    webSearch: { ...fieldsOf(settings["webSearch"]), allowedProviders: providers },
    searchRouting: {
      ...fieldsOf(settings["searchRouting"]),
      providers,
      // As pi-web-access's own routing example: on to the next provider when one is down, out of
      // quota, unreachable, answers badly or cannot serve the request, such as a domain filter.
      fallbackOn: ["transient", "quota", "network", "invalid-response", "unsupported"],
    },
    // Only the subscription's sign-in, never a key: with provider URL reuse, pi-web-access refuses
    // to search when that sign-in fails rather than fall back to `openaiApiKey` or `OPENAI_API_KEY`.
    // An explicit Responses URL turns that reuse off, so none is kept.
    ...(pinned ? { openaiSearchProviders: [subscription], openaiUseProviderBaseUrl: true } : {}),
  };
}
