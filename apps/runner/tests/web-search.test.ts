import { Result } from "effect";
import { expect, test } from "vite-plus/test";

import { planWebSearch, type WebSearchInput } from "../src/web-search.ts";

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
    searchRouting: { providers: ["brave", "exa"], fallbackOn: ["transient", "quota", "network"] },
  });
});

test("on the defaults, a ChatGPT subscription searches through its sign-in only, never a key", () => {
  expect(Result.getOrThrow(plan({ subscription: "openai-codex" })).settings).toEqual({
    tools: on,
    pdf: { provider: "unpdf" },
    webSearch: { allowedProviders: ["openai"] },
    searchRouting: { providers: ["openai"], fallbackOn: ["transient", "quota", "network"] },
    openaiSearchProviders: ["openai-codex"],
    openaiUseProviderBaseUrl: true,
  });
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
