import { Predicate, Schema } from "effect";

// What the Runner reads and changes in pi-web-access's settings file, as of the version the image's
// folder pins: whether web search is on, and through which providers. Checked on each upgrade of
// that version (ADR 0039).

/** pi-web-access's settings file in the extensions' agent directory. */
export const WEB_SEARCH_SETTINGS = "web-search.json";

const Switch = Schema.Struct({ enabled: Schema.optional(Schema.Boolean) });

/** The parts of the settings that say whether search is on and where it may go; the rest is kept. */
const SearchState = Schema.Struct({
  tools: Schema.optional(Schema.Struct({ webSearch: Schema.optional(Switch) })),
  webSearch: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      allowedProviders: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
});

/**
 * The Pi provider whose sign-in is always a ChatGPT subscription, which pi-web-access can search
 * through. Not `openai` signed in with ChatGPT: `login --with-api-key` can replace that sign-in with a
 * key while the Runner runs, and its searches would then be billed to the key until it restarts.
 */
export const CHATGPT_PROVIDER = "openai-codex";

const TURN_ON =
  "To turn it on, name the providers jobs may use in pi-web-access's web-search.json, in the folder RUNNER_EXTENSION_SETTINGS_DIR names (apps/runner/README.md).";

export interface WebSearchInput {
  /** The settings the extensions would read. */
  readonly settings: { readonly [key: string]: unknown };
  /** Whether the operator gave these settings, in the settings folder, rather than the set's defaults. */
  readonly chosen: boolean;
  /** The provider of the ChatGPT subscription the jobs' model runs on, if it runs on one. */
  readonly subscription: string | undefined;
  /** Whether `OPENAI_API_KEY` is set, which pi-web-access's OpenAI search falls back to. */
  readonly openAiKey: boolean;
}

export interface WebSearchPlan {
  /** Settings to write in place of the defaults, when the Runner turns search on itself. */
  readonly settings?: { readonly [key: string]: unknown };
  /** What the operator is told as the Runner starts. */
  readonly message: string;
  /** Whether the message is a warning. */
  readonly warning?: boolean;
}

/**
 * What the Runner does with pi-web-access's settings, and says about them. Search is the operator's
 * choice, with one exception: on the default settings, a model that runs on a ChatGPT subscription
 * searches through that subscription, which costs no money per search and sends queries to the
 * company that already answers the jobs, as pi-web-access itself does by default. Never through a
 * key: with `OPENAI_API_KEY` set, pi-web-access would fall back to it, at that key's cost.
 */
export function planWebSearch(input: WebSearchInput): WebSearchPlan {
  const state = Schema.decodeUnknownSync(SearchState)(input.settings);
  // As pi-web-access decides: the tool's own switch, then the older one, on unless either says off.
  const on = state.tools?.webSearch?.enabled ?? state.webSearch?.enabled ?? true;
  const providers = state.webSearch?.allowedProviders;
  if (!input.chosen && !on && input.subscription !== undefined) {
    if (input.openAiKey) {
      return {
        message: `Web search is off: the model runs on a ChatGPT subscription, but OPENAI_API_KEY is set, which pi-web-access would fall back to at that key's cost. ${TURN_ON}`,
      };
    }
    return {
      settings: withSubscriptionSearch(input.settings, input.subscription),
      message:
        "Web search is on through the ChatGPT subscription the model runs on, and uses its limits. To change it, give pi-web-access's own web-search.json in the folder RUNNER_EXTENSION_SETTINGS_DIR names.",
    };
  }
  if (!on) return { message: `Web search is off. ${TURN_ON}` };
  if (providers === undefined) {
    return {
      warning: true,
      message:
        "Web search may use any provider pi-web-access finds a key for, keyless ones included: name the providers jobs may use in webSearch.allowedProviders in web-search.json.",
    };
  }
  const using = `Web search uses ${providers.join(", ")}.`;
  return input.subscription !== undefined && !providers.includes("openai")
    ? {
        message: `${using} The ChatGPT subscription the model runs on can also search: add "openai" to webSearch.allowedProviders in web-search.json.`,
      }
    : { message: using };
}

const object = (value: unknown) => (Predicate.isObject(value) ? value : {});

/** `settings` with search on through `provider`'s ChatGPT subscription only. */
function withSubscriptionSearch(settings: { readonly [key: string]: unknown }, provider: string) {
  const tools = object(settings["tools"]);
  return {
    ...settings,
    tools: {
      ...tools,
      webSearch: { ...object(tools["webSearch"]), enabled: true },
      sourceCheck: { ...object(tools["sourceCheck"]), enabled: true },
    },
    webSearch: { ...object(settings["webSearch"]), allowedProviders: ["openai"] },
    // pi-web-access tries these Pi providers' sign-ins before any key; only the subscription's.
    openaiSearchProviders: [provider],
  };
}
