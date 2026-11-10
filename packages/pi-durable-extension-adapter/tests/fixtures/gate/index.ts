import { existsSync, writeFileSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// An extension that gates tool calls, blocking `echo`, with a tool that ends its worker. It loads
// once: loaded again, as after its worker's exit, it fails, as one does whose resources are gone.
export default function extension(pi: ExtensionAPI) {
  const marker = process.env.GATE_MARKER;
  if (!marker) throw new Error("GATE_MARKER is not set");
  if (existsSync(marker)) throw new Error("Loaded once already");
  writeFileSync(marker, "");
  pi.on("tool_call", (event) =>
    event.toolName === "echo" ? { block: true, reason: "Not echo" } : undefined,
  );
  pi.registerTool({
    name: "crash",
    label: "Crash",
    description: "End the worker",
    parameters: Type.Object({}),
    execute() {
      process.exit(1);
    },
  });
}
