import type { RunnerSetup } from "contract";
import { Option, Predicate, Result, Schema, Struct } from "effect";
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
  const allowed = providerList(fieldsOf(settings["webSearch"])["allowedProviders"]);
  return Result.succeed(
    allowed === undefined
      ? {
          warning: true,
          message:
            "Web search may use any provider pi-web-access finds a key for, keyless ones included: name the providers jobs may use in webSearch.allowedProviders in web-search.json.",
        }
      : { message: `Web search is on through ${allowed.join(", ")}.${source}` },
  );
}

/** What the Runner reports about web search: what pi-web-access's settings come to. */
export type WebSearchSetup = NonNullable<RunnerSetup["webSearch"]>;

/**
 * The Pi providers whose login pi-web-access's OpenAI searches use when its settings name none, in
 * order (`openai-search.ts`).
 */
const DEFAULT_OPENAI_LOGINS = [CHATGPT_PROVIDER, "openai"];

/**
 * What pi-web-access does with `settings`, the Runner's environment `env` and the jobs' model's
 * provider `modelProvider`, as of the version the image's folder pins: whether jobs can search,
 * through which providers in the order searches try them, and for OpenAI, which logins pay for its
 * searches and whether an API key can. Only a search confined to a ChatGPT subscription's sign-in
 * is reported as never billed to a key: any other login, a gateway's included, may hold one.
 */
export function describeWebSearch(
  settings: Settings,
  env: { readonly [name: string]: string | undefined },
  modelProvider: string,
): WebSearchSetup {
  if (!isOn(settings)) return { enabled: false };
  // A configured provider, under either name and even `auto`, turns the routing off.
  const routing = ["provider", "searchProvider"].some((key) => Object.hasOwn(settings, key))
    ? {}
    : fieldsOf(settings["searchRouting"]);
  const routed = providerList(routing["providers"]);
  const allowed = providerList(fieldsOf(settings["webSearch"])["allowedProviders"]);
  // Routing tries its providers in order; the other allowed ones serve only a search that names them.
  const allowedProviders = allowed && [...new Set([...(routed ?? []), ...allowed])];
  if (allowedProviders !== undefined && !allowedProviders.includes(OPENAI_SEARCH))
    return { enabled: true, allowedProviders };
  const configured = Option.match(
    Schema.decodeUnknownOption(Schema.Array(Schema.String))(settings["openaiSearchProviders"]),
    { onNone: () => DEFAULT_OPENAI_LOGINS, onSome: (logins) => logins.map((id) => id.trim()) },
  );
  // Routed OpenAI searches go through the jobs' own model instead.
  const throughModel = routing["useCurrentModel"] === true && routed?.includes(OPENAI_SEARCH);
  const logins = [...new Set(throughModel ? [modelProvider, ...configured] : configured)];
  const keyFallback =
    settings["openaiResponsesUrl"] !== undefined || settings["openaiUseProviderBaseUrl"] !== true;
  const keySet = [env["OPENAI_API_KEY"], settings["openaiApiKey"]].some(
    (key) => typeof key === "string" && key !== "",
  );
  const subscriptionOnly = logins.length > 0 && logins.every((login) => login === CHATGPT_PROVIDER);
  return {
    enabled: true,
    ...(allowedProviders === undefined ? {} : { allowedProviders }),
    openai: { logins, mayUseApiKey: (keyFallback && keySet) || !subscriptionOnly },
  };
}

/** Search providers as pi-web-access reads a list of them: trimmed and lowercased. */
const providerList = (value: unknown) =>
  Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.Array(Schema.String))(value).pipe(
      Option.map((names) => names.map((name) => name.trim().toLowerCase())),
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
