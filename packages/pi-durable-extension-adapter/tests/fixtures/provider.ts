import { once } from "node:events";
import { basename } from "node:path";

import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { contentText } from "@earendil-works/pi-ai/utils/text";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";

export default function extension(pi: ExtensionAPI) {
  pi.registerProvider("anthropic", { baseUrl: "https://proxy.example" });
  const faux = createFauxCore({ provider: "fixture", api: "fixture", models: [{ id: "echo" }] });
  const tool = (name: string) =>
    fauxAssistantMessage([fauxToolCall(name, {})], { stopReason: "toolUse" });
  let owner = "";
  // Keep the signal of the original request, including across later requests returning tool results.
  let request: AbortSignal | undefined;
  const config: ProviderConfig = {
    api: faux.api,
    baseUrl: "https://fixture.example",
    apiKey: "unused",
    models: faux.models,
    streamSimple(model, transcript, options) {
      const last = transcript.messages.at(-1);
      faux.setResponses([
        async () => {
          if (last?.role === "toolResult") {
            request?.throwIfAborted();
            return last.toolName === "begin"
              ? tool("receipt")
              : fauxAssistantMessage(contentText(last.content));
          }
          request = options?.signal;
          const text = last?.role === "user" ? contentText(last.content) : "";
          if (text === "wait for provider" && request && !request.aborted)
            await once(request, "abort");
          if (text === "call two tools") return tool("begin");
          if (text === "call tool") return tool("receipt");
          if (text === "endpoint") return fauxAssistantMessage(model.baseUrl);
          if (text === "header")
            return fauxAssistantMessage(options?.headers?.["x-fixture"] ?? "missing");
          return fauxAssistantMessage(owner + ": " + text);
        },
      ]);
      return faux.streamSimple(model, transcript, options);
    },
  };

  pi.on("session_start", (_event, ctx) => {
    owner = basename(ctx.cwd);
    if (!ctx.modelRegistry.getProvider("openai")) throw new Error("Missing built-in provider");
    if (!ctx.modelRegistry.getProvider("fixture")) pi.registerProvider("fixture", config);
  });
  pi.on("input", ({ text }) => {
    if (text === "status") {
      return {
        action: "transform",
        text: request ? (request.aborted ? "aborted" : "open") : "idle",
      };
    }
    if (text === "refresh") {
      pi.registerProvider("fixture", {
        ...config,
        models: [...faux.models, { ...faux.getModel(), id: "new", baseUrl: undefined }],
      });
    }
    if (text === "add headers")
      pi.registerProvider("fixture", { headers: { "x-fixture": "updated" } });
    if (text === "change endpoint")
      pi.registerProvider("fixture", { baseUrl: "https://other.example" });
    if (text === "invalid stream") {
      try {
        pi.registerProvider("fixture", { streamSimple: faux.streamSimple });
      } catch (error) {
        return {
          action: "transform",
          text: error instanceof Error ? error.message : String(error),
        };
      }
    }
  });
}
