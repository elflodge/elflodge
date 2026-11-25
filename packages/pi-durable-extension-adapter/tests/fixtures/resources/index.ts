import { appendFileSync } from "node:fs";

import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// An extension that keeps resources per session in its module, as pi-ai's providers do, and writes
// the ID of each session whose resources are released to the file `RESOURCES_LOG` names.
registerSessionResourceCleanup((sessionId) => {
  const log = process.env.RESOURCES_LOG;
  if (log) appendFileSync(log, `${sessionId}\n`);
});

export default function extension(_pi: ExtensionAPI) {}
