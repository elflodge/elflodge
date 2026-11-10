import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// An extension with a flag, whose value a tool returns, and a tool that ends its worker. It
// observes tool calls without gating them.
export default function extension(pi: ExtensionAPI) {
  pi.registerFlag("greeting", { type: "string", default: "hello", description: "How to greet" });
  pi.registerTool({
    name: "greet",
    label: "Greet",
    description: "Greet",
    parameters: Type.Object({}),
    async execute() {
      const greeting = String(pi.getFlag("greeting"));
      return { content: [{ type: "text", text: greeting }], details: {} };
    },
  });
  pi.registerTool({
    name: "crash",
    label: "Crash",
    description: "End the worker",
    parameters: Type.Object({}),
    async execute() {
      process.exit(1);
    },
  });
  pi.on("tool_execution_start", () => undefined);
}
