import { basename, dirname } from "node:path";

import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { contentText } from "@earendil-works/pi-ai/utils/text";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";

/**
 * Registers the provider "shared" as its working directory says: `<plan>/<owner>`, where the plan
 * is `<first>~<next>` for the conversation under test, what its first instance registers when
 * told and what each later instance does as it starts, or `peer-<kind>` for a peer.
 */
export default function extension(pi: ExtensionAPI) {
  const name = "shared";
  let owner = "";
  let plan = "";
  let report: { read?: { baseUrl: string | undefined } | null; error?: string } = {};
  const faux = createFauxCore({ provider: name, api: "worker-echo", models: [{ id: "echo" }] });
  const models = (generation: number) =>
    ["echo", `${owner}-${generation}`].map((id) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    }));
  const settings = (generation: number): ProviderConfig => ({
    api: "host-echo",
    baseUrl: `https://${owner}-${generation}.example`,
    apiKey: "unused",
    models: models(generation),
  });
  const custom = (generation: number): ProviderConfig => ({
    ...settings(generation),
    api: faux.api,
    streamSimple(model, transcript, options) {
      const last = transcript.messages.at(-1);
      const text = last?.role === "user" ? contentText(last.content) : "";
      faux.setResponses([fauxAssistantMessage(`${owner}-${generation} stream: ${text}`)]);
      return faux.streamSimple(model, transcript, options);
    },
  });
  const attempt = (register: () => void) => {
    try {
      register();
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
    }
  };

  pi.on("session_start", (_event, ctx) => {
    owner = basename(ctx.cwd);
    plan = basename(dirname(ctx.cwd));
    if (plan === "every-message") return pi.registerProvider(name, settings(1));
    const opened = ctx.sessionManager
      .getEntries()
      .some((entry) => entry.type === "custom" && entry.customType === "opened");
    if (!opened) {
      pi.appendEntry("opened", {});
      return;
    }
    const provider = ctx.modelRegistry.getProvider(name);
    report = { read: provider ? { baseUrl: provider.baseUrl } : null };
    const next = plan.split("~")[1];
    if (next === "settings" || (next === "settings-if-absent" && !provider))
      attempt(() => pi.registerProvider(name, settings(2)));
    if (next === "custom" || (next === "custom-if-absent" && !provider))
      attempt(() => pi.registerProvider(name, custom(2)));
  });
  pi.on("input", ({ text }) => {
    if (text === "exit") process.exit(1);
    if (text === "report") return { action: "transform", text: JSON.stringify(report) };
    if (text === "first") {
      const first = plan.startsWith("peer-") ? plan.slice(5) : plan.split("~")[0];
      if (first === "settings" || first === "settings-then-custom")
        attempt(() => pi.registerProvider(name, settings(1)));
      if (first === "custom" || first === "settings-then-custom")
        attempt(() => pi.registerProvider(name, custom(1)));
      return { action: "transform", text: JSON.stringify(report) };
    }
  });
  // As some extensions do: register the same settings again after every message.
  pi.on("message_end", () => {
    if (plan === "every-message") pi.registerProvider(name, settings(1));
  });
}
