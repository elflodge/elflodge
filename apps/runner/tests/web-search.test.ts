import { Result } from "effect";
import { expect, test } from "vite-plus/test";

import { DEFAULT_NETWORK_SETTINGS, type NetworkSettings } from "../src/network.ts";
import {
  describeWebSearch,
  planWebSearch,
  type WebSearchInput,
  withNetwork,
} from "../src/web-search.ts";

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

// What the Runner reports about search tells members whether jobs can search, where queries may
// go and whether a search may be billed to an API key. It says no key pays only where the Runner
// confined searches to a ChatGPT subscription itself; anywhere else it says a key may pay.

const capability = (input: Partial<WebSearchInput>) => Result.getOrThrow(plan(input)).capability;

test("search is reported off only when neither searching tool is on", () => {
  expect(capability({})).toEqual({ enabled: false });
  const sourceCheckOnly = {
    tools: { webSearch: { enabled: false }, sourceCheck: { enabled: true } },
  };
  expect(capability({ settings: sourceCheckOnly, chosen: true }).enabled).toBe(true);
});

test("search the Runner confines to a subscription's sign-in is reported as never billed to a key", () => {
  const confined = { enabled: true, allowedProviders: ["openai"], openai: { mayUseApiKey: false } };
  expect(capability({ subscription: "openai-codex" })).toEqual(confined);
  expect(capability({ providers: ["openai"], subscription: "openai-codex" })).toEqual(confined);
});

test("named providers are reported as the only ones, with OpenAI billing only when openai is one", () => {
  expect(capability({ providers: ["brave"] })).toEqual({
    enabled: true,
    allowedProviders: ["brave"],
  });
  expect(capability({ providers: ["brave", "openai"] }).openai).toEqual({ mayUseApiKey: true });
});

test("the operator's own settings may always bill a key, even confined as the Runner would", () => {
  const confined = Result.getOrThrow(plan({ subscription: "openai-codex" })).settings ?? {};
  expect(capability({ settings: confined, chosen: true })).toEqual({
    enabled: true,
    allowedProviders: ["openai"],
    openai: { mayUseApiKey: true },
  });
});

test("pi-web-access's own defaults are reported as open to any provider and to a key", () => {
  expect(describeWebSearch({})).toEqual({ enabled: true, openai: { mayUseApiKey: true } });
});

// pi-web-access's requests leave from the Runner, outside jobs' sandboxes, so the jobs' network
// reaches them only through its settings. That its requests go through jobs' proxy is tested
// through a job, in the hub's `web-access.test.ts`.
const PROXY = "http://runner:token@127.0.0.1:4100";
const held = (settings: Record<string, unknown>, network: NetworkSettings) =>
  Result.getOrThrow(withNetwork(settings, { settings: network, proxy: PROXY }));

test("pi-web-access fetches no page when jobs have no network, and reaches the operator's exception ranges otherwise", () => {
  expect(held(defaults, { mode: "none", exceptions: [] })).toEqual({
    ...defaults,
    tools: { ...defaults.tools, fetchContent: { enabled: false } },
    fetchContent: { domainPolicy: { allow: ["invalid"], deny: ["invalid"] } },
    githubClone: { enabled: false },
    githubPrIssue: { enabled: false },
  });
  // A range opened on one port is left out where pi-web-access would reach it without jobs' proxy,
  // which holds it to the port.
  const exceptions = [
    { range: "10.20.0.0/16" },
    { range: "10.30.0.0/16", port: 8080 },
    { range: "127.0.0.1/32", port: 8080 },
  ];
  expect(held(defaults, { mode: "open", exceptions })).toMatchObject({
    ssrf: { allowRanges: ["10.20.0.0/16", "10.30.0.0/16"] },
  });
});

test("an operator's own proxy or allowed ranges for pi-web-access are refused while jobs' network is open", () => {
  for (const own of [
    { proxy: "http://proxy.example:3128" },
    { ssrf: { allowRanges: ["127.0.0.1/32"] } },
  ]) {
    expect(
      Result.isFailure(withNetwork(own, { settings: DEFAULT_NETWORK_SETTINGS, proxy: PROXY })),
      JSON.stringify(own),
    ).toBe(true);
  }
  // With no network, every page fetch is refused before its address is checked.
  const own = { ssrf: { allowRanges: ["127.0.0.1/32"] } };
  expect(held(own, { mode: "none", exceptions: [] })).toMatchObject(own);
});
