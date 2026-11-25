import type { ExtensionAPI, SessionCompactFailedEvent } from "@earendil-works/pi-coding-agent";

// An extension that records the compactions it is told failed, and saves them at the end of the
// session.
export default function extension(pi: ExtensionAPI) {
  const failed: SessionCompactFailedEvent[] = [];
  pi.on("session_compact_failed", (event) => void failed.push(event));
  pi.on("session_shutdown", () => pi.appendEntry("failed", failed));
}
