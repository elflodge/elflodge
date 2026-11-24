import { once } from "node:events";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { setTimeout } from "node:timers/promises";

import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { contentText } from "@earendil-works/pi-ai/utils/text";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import ensureError from "ensure-error";

// The queries of the conversations on this worker, by owner, which a neighbour can report.
const queries = new Map<string, AbortSignal | undefined>();

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
      const text = last?.role === "user" ? contentText(last.content) : "";
      faux.setResponses([
        async () => {
          // As a provider that keeps its query open while tools run: only the instance that
          // started it can answer a tool's result.
          if (last?.role === "toolResult") {
            if (!request) throw new Error("No query of this conversation waits for a tool result");
            request.throwIfAborted();
            return last.toolName === "begin"
              ? tool("receipt")
              : fauxAssistantMessage(owner + ": " + contentText(last.content));
          }
          request = options?.signal;
          queries.set(owner, request);
          if (text === "crash") process.exit(3);
          if (/^(wait for provider|ignore abort)$/.test(text) && request && !request.aborted)
            await once(request, "abort");
          // As a provider that finishes its answer after the cancellation.
          if (text === "ignore abort") return tool("stubborn");
          if (text === "call two tools") return tool("begin");
          if (text === "call tool") return tool("receipt");
          if (text === "call stubborn tool") return tool("stubborn");
          if (text === "payload")
            return fauxAssistantMessage(
              JSON.stringify(await options?.onPayload?.({ owner }, model)),
            );
          if (text === "endpoint") return fauxAssistantMessage(model.baseUrl);
          if (text === "header")
            return fauxAssistantMessage(options?.headers?.["x-fixture"] ?? "missing");
          await options?.onProviderStreamEvent?.({ owner }, model);
          return fauxAssistantMessage(owner + ": " + text);
        },
      ]);
      return faux.streamSimple(
        model,
        transcript,
        text === "ignore abort" ? { ...options, signal: undefined } : options,
      );
    },
  };

  const { streamSimple: _, ...settings } = config;

  pi.on("session_start", async ({ reason }, ctx) => {
    owner = basename(ctx.cwd);
    // Holds a reopening while the test keeps the file beside the working directory.
    while (reason === "resume" && existsSync(`${ctx.cwd}.hold`)) await setTimeout(20);
    if (!ctx.modelRegistry.getProvider("openai")) throw new Error("Missing built-in provider");
    // As an extension that starts with its provider's settings and adds a stream from a handler.
    if (owner === "carol") pi.registerProvider("late", settings);
    // As an extension that points the provider at a server the app reaches with a built-in API.
    if (owner === "dave")
      pi.registerProvider("fixture", {
        api: "host-echo",
        baseUrl: "https://dave.example",
        models: [
          {
            id: "echo",
            name: "echo",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1000,
            maxTokens: 100,
          },
        ],
      });
    else if (!ctx.modelRegistry.getProvider("fixture")) pi.registerProvider("fixture", config);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    // Holds the shutdown while the test keeps the file beside the working directory.
    while (existsSync(`${ctx.cwd}.shutdown`)) await setTimeout(20);
  });
  pi.on("input", ({ text }) => {
    if (text === "status" || text.startsWith("status of ")) {
      const query = text === "status" ? request : queries.get(text.slice("status of ".length));
      return { action: "transform", text: query ? (query.aborted ? "aborted" : "open") : "idle" };
    }
    if (text === "exit") process.exit(1);
    if (text === "register late") pi.registerProvider("late", config);
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
          text: ensureError(error).message,
        };
      }
    }
  });
}
