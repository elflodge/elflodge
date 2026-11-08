import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, type Message } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { expect, onTestFinished, test } from "vite-plus/test";

import { startExtensionHost } from "../src/host.ts";
import { prepareExtensions } from "../src/prepare.ts";

const fixture = path.join(import.meta.dirname, "fixtures", "notes");

function toolResults(messages: readonly Message[]) {
  return messages.flatMap((message) =>
    message.role === "toolResult"
      ? [
          {
            tool: message.toolName,
            text: message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
            isError: message.isError,
          },
        ]
      : [],
  );
}

test("a conversation runs an extension's tools, saved entries, gate and input transform", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-durable-compat-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const prepared = await prepareExtensions({ sources: [fixture], dir });
  expect(prepared.failures).toEqual([]);
  const host = startExtensionHost({ prepared });
  onTestFinished(() => host.close());

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  let seen: readonly Message[] = [];
  faux.setResponses([
    // The tags arrive as JSON text: pi-durable validates them on the host, where an array sent as
    // text is parsed for a tool with `prepareArguments`, before the tool's own runs in the worker.
    fauxAssistantMessage([fauxToolCall("remember", { text: "milk", tags: '["shop"]' })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxToolCall("remember", { text: "eggs", tags: [] })], {
      stopReason: "toolUse",
    }),
    // Saved already, which the extension's `tool_call` handler reads from the session.
    fauxAssistantMessage([fauxToolCall("remember", { text: "milk", tags: [] })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxToolCall("recall", { order: "newest" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("danger", {})], { stopReason: "toolUse" }),
    (request) => {
      seen = request.messages;
      return fauxAssistantMessage([fauxText("Done.")]);
    },
  ]);
  const registry = createRegistry();
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  onTestFinished(() => harness.close(context));
  const conversation = await harness.root(context, {
    agent: { model: { provider: model.provider, modelId: model.id } },
  });
  const extensions = await host.attach(
    { harness, conversation, registry, models, cwd: dir },
    context,
  );
  expect(extensions.errors).toEqual([]);

  const input = await extensions.input("Note my shopping", undefined, context);
  expect(input).toEqual({ action: "transform", text: "Note my shopping!", images: undefined });
  const submission = await conversation.submit(
    { type: "input", content: "Note my shopping!" },
    context,
  );
  await submission.wait(context);

  expect(toolResults(seen)).toEqual([
    { tool: "remember", text: "Saved milk", isError: false },
    { tool: "remember", text: "Saved eggs", isError: false },
    { tool: "remember", text: expect.stringContaining("Already saved"), isError: true },
    {
      tool: "recall",
      text: JSON.stringify([
        { text: "eggs", tags: [] },
        { text: "milk", tags: ["shop"] },
      ]),
      isError: false,
    },
    { tool: "danger", text: expect.stringContaining("Not allowed"), isError: true },
  ]);
  await extensions.close();
});
