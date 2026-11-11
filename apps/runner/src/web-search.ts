import { Option, Predicate, Result, Schema, Struct } from "effect";

// What the Runner reads and changes in pi-web-access's settings file, as of the version the image's
// folder pins: whether web search is on, through which providers, and with which credentials.
// Checked on each upgrade of that version (ADR 0039).

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
  readonly providers: readonly string[] | undefined;
  /** The jobs' model's provider, when it is a ChatGPT subscription. */
  readonly subscription: string | undefined;
}

export interface WebSearchPlan {
  /** Settings to write in place of the defaults, when the Runner turns search on. */
  readonly settings?: Settings;
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
      message: `Web search is on through ${providers.join(", ")}.${also}`,
    });
  }
  if (!chosen && subscription !== undefined && !isOn(settings)) {
    return Result.succeed({
      settings: withSearch(settings, [OPENAI_SEARCH], subscription),
      message: `Web search is on through the ChatGPT subscription the model runs on, and uses its limits. RUNNER_WEB_SEARCH names other providers instead; include ${OPENAI_SEARCH} to keep it.`,
    });
  }
  const source = chosen ? " web-search.json in RUNNER_EXTENSION_SETTINGS_DIR chooses it." : "";
  if (!isOn(settings)) {
    return Result.succeed({ message: `Web search is off.${chosen ? source : ` ${TURN_ON}`}` });
  }
  const allowed = Schema.decodeUnknownOption(Schema.Array(Schema.String))(
    fieldsOf(settings["webSearch"])["allowedProviders"],
  );
  return Result.succeed(
    Option.match(allowed, {
      onNone: () => ({
        warning: true,
        message:
          "Web search may use any provider pi-web-access finds a key for, keyless ones included: name the providers jobs may use in webSearch.allowedProviders in web-search.json.",
      }),
      onSome: (names) => ({ message: `Web search is on through ${names.join(", ")}.${source}` }),
    }),
  );
}

/**
 * Whether search is on, as pi-web-access decides: the tool's own switch, else the older one, else
 * on. A value that is not a boolean counts as unset, as it does there.
 */
function isOn(settings: Settings) {
  return (
    flag(fieldsOf(fieldsOf(settings["tools"])["webSearch"])["enabled"]) ??
    flag(fieldsOf(settings["webSearch"])["enabled"]) ??
    true
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
