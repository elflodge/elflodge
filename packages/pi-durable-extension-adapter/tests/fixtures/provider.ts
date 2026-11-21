import { once } from "node:events";
import { basename } from "node:path";

import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { contentText } from "@earendil-works/pi-ai/utils/text";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// A provider that keeps a request open until its tool returns or the user cancels it.
export default function extension(pi: ExtensionAPI) {
  pi.registerProvider("anthropic", { baseUrl: "https://proxy.example" });
  const faux = createFauxCore({ provider: "fixture", api: "fixture", models: [{ id: "echo" }] });
  let request: AbortSignal | undefined;
  pi.on("input", ({ text }) => {
    if (text === "status") {
      return {
        action: "transform",
        text: request ? (request.aborted ? "aborted" : "open") : "idle",
      };
    }
  });
  pi.on("session_start", (_event, ctx) => {
    pi.registerProvider("fixture", {
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
              return fauxAssistantMessage(contentText(last.content));
            }
            request = options?.signal;
            const text = last?.role === "user" ? contentText(last.content) : "";
            if (text === "wait for provider" && request && !request.aborted) {
              await once(request, "abort");
            }
            if (text === "call tool") {
              return fauxAssistantMessage([fauxToolCall("receipt", {})], { stopReason: "toolUse" });
            }
            return fauxAssistantMessage(basename(ctx.cwd) + ": " + text);
          },
        ]);
        return faux.streamSimple(model, transcript, options);
      },
    });
  });
}
