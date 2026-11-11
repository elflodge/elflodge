import { expect, test } from "vite-plus/test";

import { planWebSearch } from "../src/web-search.ts";

// Web search may spend money and send jobs' queries elsewhere, so the Runner turns it on only where
// that is free and goes nowhere new: on the defaults, through the ChatGPT subscription the jobs'
// model runs on. These hold it to that.

const defaults = {
  tools: { webSearch: { enabled: false }, sourceCheck: { enabled: false } },
  pdf: { provider: "unpdf" },
};

test("on the defaults, a ChatGPT subscription searches through itself only", () => {
  expect(
    planWebSearch({
      settings: defaults,
      chosen: false,
      subscription: "openai-codex",
      openAiKey: false,
    }).settings,
  ).toEqual({
    tools: { webSearch: { enabled: true }, sourceCheck: { enabled: true } },
    pdf: { provider: "unpdf" },
    webSearch: { allowedProviders: ["openai"] },
    openaiSearchProviders: ["openai-codex"],
  });
});

test("search stays off where pi-web-access could fall back to an OpenAI key", () => {
  const plan = planWebSearch({
    settings: defaults,
    chosen: false,
    subscription: "openai-codex",
    openAiKey: true,
  });
  expect(plan.settings).toBeUndefined();
  expect(plan.message).toContain("OPENAI_API_KEY");
});

test("the operator's own settings are used as given", () => {
  expect(
    planWebSearch({
      settings: defaults,
      chosen: true,
      subscription: "openai-codex",
      openAiKey: false,
    }).settings,
  ).toBeUndefined();
});
