import { existsSync } from "node:fs";
import { setTimeout } from "node:timers/promises";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// An extension whose `session_compact` handler takes a while, as one that drops its provider's open
// query after a compaction can: held while the test keeps the file beside the working directory.
export default function extension(pi: ExtensionAPI) {
  pi.on("session_compact", async (_event, ctx) => {
    while (existsSync(`${ctx.cwd}.compact`)) await setTimeout(20);
  });
}
