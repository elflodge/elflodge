import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { expect, test } from "vite-plus/test";

import { readEvents } from "../src/journal.ts";

test("a tool that disappears after it ran can be distinguished from a missing tool in reported events", async () => {
  const registry = createRegistry();
  const extension = defineExtension({
    name: "temporary",
    tools: [
      defineTool({
        name: "lookup",
        description: "Look up a record",
        parameters: obj({}),
        execute: async () => {
          registry.uninstall(extension);
          return { sleep: { until: Date.now() } };
        },
      }),
    ],
  });
  registry.install(extension);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("lookup", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("missing", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done"),
  ]);
  const ctx = BACKGROUND_CONTEXT;
  const harness = await Harness.open(new MemoryStorage(), { registry, models }, ctx);
  try {
    const root = await harness.root(ctx, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });
    const submission = await root.submit({ type: "input", content: "Look up a record." }, ctx);
    await submission.wait(ctx);
    const { events } = await readEvents(harness, 0, Number.POSITIVE_INFINITY);
    const results = events.filter(
      (event) => event.type === "entry" && event.record.kind === ToolResultEntry.kind,
    );
    expect(results).toMatchObject([
      {
        toolTaskOutcome: "failed",
        record: { data: { diagnostics: [{ code: "tool_unavailable" }] } },
      },
      {
        toolTaskOutcome: "completed",
        record: { data: { diagnostics: [{ code: "tool_unavailable" }] } },
      },
    ]);
  } finally {
    await harness.close(ctx);
  }
});
