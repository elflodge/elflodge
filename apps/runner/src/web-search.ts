import { excludeCidr } from "cidr-tools";
import type { RunnerCapabilities } from "contract";
import { Array, Option, Predicate, Result, Schema, Struct } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";

import type { NetworkSettings } from "./network.ts";

// What the Runner reads and changes in pi-web-access's settings file, as of the version the image's
// folder pins: whether web search is on, through which providers, and with which credentials, and
// what its requests may reach. Checked on each upgrade of that version (ADR 0039).

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
      ...searchThrough(settings, providers, subscription),
      message: `Web search is on through ${providers.join(", ")}.${also}`,
    });
  }
  if (!chosen && subscription !== undefined && !isOn(settings)) {
    return Result.succeed({
      ...searchThrough(settings, [OPENAI_SEARCH], subscription),
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
 * `settings` with search on through exactly `providers`, and what the Runner reports of them. The
 * report says no key pays exactly when these settings pin OpenAI searches to the subscription, so
 * both come from one decision.
 */
function searchThrough(
  settings: Settings,
  providers: readonly string[],
  subscription: string | undefined,
): { settings: Settings; capability: WebSearchCapability } {
  const openai = providers.includes(OPENAI_SEARCH);
  const pinned = openai && subscription !== undefined;
  return {
    settings: withSearch(settings, providers, pinned ? subscription : undefined),
    capability: {
      enabled: true,
      allowedProviders: [...providers],
      ...(openai ? { openai: { mayUseApiKey: !pinned } } : {}),
    },
  };
}

/**
 * `settings` with search on through exactly `providers`, tried in that order, and OpenAI searches
 * pinned to `pinnedTo`'s sign-in when given. pi-web-access's automatic choice skips the providers
 * it calls explicit-only even when they are allowed, so the list is its routing as well as its
 * allowlist; a single default provider would override the routing, so none is kept.
 */
function withSearch(settings: Settings, providers: readonly string[], pinnedTo?: string) {
  const tools = fieldsOf(settings["tools"]);
  const pinned = pinnedTo !== undefined;
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
    ...(pinned ? { openaiSearchProviders: [pinnedTo], openaiUseProviderBaseUrl: true } : {}),
  };
}

/** Jobs' network, as the Runner holds pi-web-access to it. */
export interface JobsNetwork {
  readonly settings: NetworkSettings;
  /** sandbox-runtime's proxy for the Runner's own requests, when jobs run in a sandbox. */
  readonly proxy: string | undefined;
}

/**
 * pi-web-access's own User-Agent for pages, `DEFAULT_FETCH_CONTENT_USER_AGENT` in its
 * `ssrf-protection.ts` (0.47.0), which it does not export: through `fetchContent.curl` it sends only
 * a configured one, so that curl-impersonate keeps its browser's, and pages would otherwise see
 * curl's.
 */
const PI_WEB_ACCESS_USER_AGENT = "OpenAI File Downloader, XaiImageApiFetch/1.0";

/**
 * The addresses pi-web-access fetches without its proxy, as `isProxyBypassedUrl` in its `utils.ts`
 * (0.47.0) lists them, `metadata.google.internal` resolving to the last.
 */
const PROXY_BYPASSED = ["127.0.0.1/32", "::1/128", "169.254.169.254/32"];

/**
 * `settings` held to jobs' network (ADR 0041), or `undefined` when that changes nothing, or why
 * they cannot be. pi-web-access runs in the Runner's process, outside every sandbox.
 *
 * In either mode, GitHub cloning and the `gh` lookups of issues and pull requests are off: `git`
 * and `gh` reach GitHub themselves, past any proxy and past the checks below, even for a URL whose
 * scheme pi-web-access does not fetch, such as `ftp://github.com/…`; pages on GitHub are fetched as
 * other pages are.
 *
 * With no network, pi-web-access fetches no page, while search, through providers the operator
 * chose, keeps working, with the page text a provider returns beside its results. `fetch_content`
 * is off, and `fetchContent.domainPolicy` allows only `invalid`, a name reserved never to resolve
 * (RFC 6761), which refuses every page before it is looked up or fetched, by pi-web-access or
 * through a fetching service: the pages `web_search` adds to what a provider returned
 * (`includeContent`), `source_check`'s, and those of `mode: "raw"`. It gets no proxy, which would
 * carry the providers' requests too, and refuse them.
 *
 * Open, with a sandbox, every request goes through sandbox-runtime's proxy, which refuses what it
 * refuses jobs' commands: `proxy` names it, `lockProxy` keeps a call from naming another, and
 * `ssrf.trustEnvProxy` lets the proxy, which checks the address it dials, judge a name in place of
 * pi-web-access's narrower check of its own resolution. IP literals and `localhost` are still
 * checked by pi-web-access first. With a proxy, pi-web-access sends every request through curl;
 * `fetchContent.curl` names it for pages too, so that curl stops at the PDF size limit
 * (`--max-filesize`) rather than download a page whole before Node rejects it, with
 * pi-web-access's own User-Agent unless the operator set one. An operator's own `proxy` would be
 * replaced, so it is refused; the Runner's `HTTPS_PROXY` reaches sandbox-runtime's proxy as its
 * upstream, which then resolves names itself, so the address checks on names no longer apply.
 *
 * The exception ranges are `ssrf.allowRanges`, the ranges pi-web-access's own guard lets through,
 * and `parseException` refused the `/0` that pi-web-access refuses. `allowRanges` has no ports, so
 * jobs' proxy holds pi-web-access to an exception's port, and a range opened on one port leaves out
 * the addresses pi-web-access reaches without it. An operator's own `allowRanges` is refused, as
 * pi-web-access would reach some of them, such as `127.0.0.1`, without jobs' proxy.
 */
export function withNetwork(
  settings: Settings,
  network: JobsNetwork,
): Result.Result<Settings | undefined, string> {
  const { mode, exceptions } = network.settings;
  // Without a sandbox, jobs' commands reach every address, and the Runner refuses to start with
  // either network setting, so there is nothing to hold pi-web-access to.
  if (network.proxy === undefined) return Result.succeed(undefined);
  const withoutGitHub = {
    ...settings,
    githubClone: { ...fieldsOf(settings["githubClone"]), enabled: false },
    githubPrIssue: { ...fieldsOf(settings["githubPrIssue"]), enabled: false },
  };
  const fetchContent = fieldsOf(settings["fetchContent"]);
  if (mode === "none") {
    const tools = fieldsOf(settings["tools"]);
    return Result.succeed({
      ...withoutGitHub,
      tools: { ...tools, fetchContent: { ...fieldsOf(tools["fetchContent"]), enabled: false } },
      fetchContent: {
        ...fetchContent,
        domainPolicy: { ...fieldsOf(fetchContent["domainPolicy"]), allow: ["invalid"] },
      },
    });
  }
  if (Predicate.isNotNullish(settings["proxy"]))
    return Result.fail(
      `${WEB_SEARCH_SETTINGS} sets proxy, which the Runner replaces to hold pi-web-access to jobs' network; give the Runner HTTPS_PROXY instead, which jobs' proxy sends requests on to, and which then resolves names itself, so neither jobs' commands nor pi-web-access have their names checked against the refused addresses`,
    );
  const ssrf = fieldsOf(settings["ssrf"]);
  if (Predicate.isNotNullish(ssrf["allowRanges"]))
    return Result.fail(
      `${WEB_SEARCH_SETTINGS} sets ssrf.allowRanges, which would let pi-web-access past its own address checks, and reach some addresses, such as 127.0.0.1, without jobs' proxy; open ranges with RUNNER_NETWORK_EXCEPTIONS instead, which the Runner gives pi-web-access too`,
    );
  const opened = exceptions.flatMap(({ range, port }) =>
    port === undefined ? [range] : excludeCidr([range], PROXY_BYPASSED),
  );
  const allowRanges = opened.length === 0 ? {} : { allowRanges: opened };
  // pi-web-access reads a `null` as unset.
  const curl = Predicate.isNullish(fetchContent["curl"])
    ? { curl: ["curl"], userAgent: fetchContent["userAgent"] ?? PI_WEB_ACCESS_USER_AGENT }
    : {};
  return Result.succeed({
    ...withoutGitHub,
    proxy: network.proxy,
    lockProxy: true,
    ssrf: { ...ssrf, ...allowRanges, trustEnvProxy: true },
    fetchContent: { ...fetchContent, ...curl },
  });
}
