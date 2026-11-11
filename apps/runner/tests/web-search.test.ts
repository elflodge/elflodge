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

// What the Runner reports about search tells members whether a job's searches may cost money per
// search, so it must follow what pi-web-access will do with the settings and the key it can find.

const KEY = { OPENAI_API_KEY: "sk-test" };

test("search reported off is off", () => {
  expect(describeWebSearch(defaults, KEY)).toEqual({ enabled: false });
});

test("search through a subscription's sign-in is reported as never billed to a key, even with one set", () => {
  const settings = Result.getOrThrow(plan({ subscription: "openai-codex" })).settings ?? {};
  expect(describeWebSearch(settings, KEY)).toEqual({
    enabled: true,
    allowedProviders: ["openai"],
    openai: { logins: ["openai-codex"], mayUseApiKey: false },
  });
});

test("search through named providers without openai reports no OpenAI billing", () => {
  const settings = Result.getOrThrow(plan({ providers: ["brave"] })).settings ?? {};
  expect(describeWebSearch(settings, KEY)).toEqual({ enabled: true, allowedProviders: ["brave"] });
});

test("pi-web-access's own defaults are reported as open to any provider, and to a key once one is set", () => {
  expect(describeWebSearch({}, {})).toEqual({
    enabled: true,
    openai: { logins: ["openai-codex", "openai"], mayUseApiKey: true },
  });
  const signedInOnly = { openaiSearchProviders: ["openai-codex"] };
  expect(describeWebSearch(signedInOnly, {}).openai?.mayUseApiKey).toBe(false);
  expect(describeWebSearch(signedInOnly, KEY).openai?.mayUseApiKey).toBe(true);
});
