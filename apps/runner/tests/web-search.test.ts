import { Result } from "effect";
import { expect, test } from "vite-plus/test";

import { describeWebSearch, planWebSearch, type WebSearchInput } from "../src/web-search.ts";

// Web search may spend money and send jobs' queries elsewhere, so it goes only where the operator
// said, once, and otherwise only through the ChatGPT subscription the jobs' model already runs on,
// never through a key. These hold the Runner to that.

const defaults = {
  tools: { webSearch: { enabled: false }, sourceCheck: { enabled: false } },
  pdf: { provider: "unpdf" },
};

const plan = (input: Partial<WebSearchInput>) =>
  planWebSearch({
    settings: defaults,
    chosen: false,
    providers: undefined,
    subscription: undefined,
    ...input,
  });

const on = { webSearch: { enabled: true }, sourceCheck: { enabled: true } };

test("named providers turn search on through exactly them, in order", () => {
  expect(Result.getOrThrow(plan({ providers: ["brave", "exa"] })).settings).toEqual({
    tools: on,
    pdf: { provider: "unpdf" },
    webSearch: { allowedProviders: ["brave", "exa"] },
    searchRouting: {
      providers: ["brave", "exa"],
      fallbackOn: ["transient", "quota", "network", "invalid-response", "unsupported"],
    },
  });
});

test("on the defaults, a ChatGPT subscription searches through its sign-in only, never a key", () => {
  expect(Result.getOrThrow(plan({ subscription: "openai-codex" })).settings).toEqual({
    tools: on,
    pdf: { provider: "unpdf" },
    webSearch: { allowedProviders: ["openai"] },
    searchRouting: {
      providers: ["openai"],
      fallbackOn: ["transient", "quota", "network", "invalid-response", "unsupported"],
    },
    openaiSearchProviders: ["openai-codex"],
    openaiUseProviderBaseUrl: true,
  });
});

test("naming openai on a subscription Runner searches through its sign-in only", () => {
  expect(
    Result.getOrThrow(plan({ providers: ["openai"], subscription: "openai-codex" })).settings,
  ).toMatchObject({ openaiSearchProviders: ["openai-codex"], openaiUseProviderBaseUrl: true });
});

test("without a subscription or named providers, search stays off", () => {
  expect(Result.getOrThrow(plan({})).settings).toBeUndefined();
});

test("the operator's own settings are used as given", () => {
  expect(
    Result.getOrThrow(plan({ chosen: true, subscription: "openai-codex" })).settings,
  ).toBeUndefined();
});

test("named providers and the operator's own settings together are refused", () => {
  expect(Result.isFailure(plan({ chosen: true, providers: ["brave"] }))).toBe(true);
});

// What the Runner reports about search tells members whether jobs can search and whether a search
// may be billed to an API key, so it must follow what pi-web-access will do with the settings and
// credentials it can find; where it cannot be sure, it says a key may pay.

const KEY = { OPENAI_API_KEY: "sk-test" };
const describe = (settings: { readonly [key: string]: unknown }, env = {}) =>
  describeWebSearch(settings, env, "anthropic");

test("search is reported off only when neither searching tool is on", () => {
  expect(describe(defaults)).toEqual({ enabled: false });
  const sourceCheckOnly = {
    tools: { webSearch: { enabled: false }, sourceCheck: { enabled: true } },
  };
  expect(describe(sourceCheckOnly).enabled).toBe(true);
});

test("search through a subscription's sign-in is reported as never billed to a key, even with one set", () => {
  const settings = Result.getOrThrow(plan({ subscription: "openai-codex" })).settings ?? {};
  expect(describe(settings, KEY)).toEqual({
    enabled: true,
    allowedProviders: ["openai"],
    openai: { logins: ["openai-codex"], mayUseApiKey: false },
  });
});

test("search through named providers without openai reports no OpenAI billing", () => {
  const settings = Result.getOrThrow(plan({ providers: ["brave"] })).settings ?? {};
  expect(describe(settings, KEY)).toEqual({ enabled: true, allowedProviders: ["brave"] });
});

test("pi-web-access's own defaults are reported as open to any provider and to a key", () => {
  expect(describe({})).toEqual({
    enabled: true,
    openai: { logins: ["openai-codex", "openai"], mayUseApiKey: true },
  });
});

test("any login but a ChatGPT subscription's may bill a key, a gateway's included", () => {
  const pinned = { openaiUseProviderBaseUrl: true };
  const loginsOf = (openaiSearchProviders: string[]) =>
    describe({ ...pinned, openaiSearchProviders }, KEY).openai?.mayUseApiKey;
  expect(loginsOf(["openai-codex"])).toBe(false);
  expect(loginsOf(["openrouter"])).toBe(true);
  expect(describe({ openaiSearchProviders: ["openai-codex"] }, KEY).openai?.mayUseApiKey).toBe(
    true,
  );
});

test("routed OpenAI searches through the jobs' model are billed as the model is", () => {
  const settings = {
    openaiSearchProviders: ["openai-codex"],
    openaiUseProviderBaseUrl: true,
    webSearch: { allowedProviders: ["brave", "openai"] },
    searchRouting: { providers: ["openai", "brave"], useCurrentModel: true },
  };
  expect(describeWebSearch(settings, {}, "openai")).toEqual({
    enabled: true,
    allowedProviders: ["openai", "brave"],
    openai: { logins: ["openai", "openai-codex"], mayUseApiKey: true },
  });
});
