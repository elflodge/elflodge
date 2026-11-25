import type { ExtensionAPI, SessionCompactFailedEvent } from "@earendil-works/pi-coding-agent";

// An extension that cancels a compaction when asked to, and records the compactions it is told
// failed, which it saves at the end of the session.
export default function extension(pi: ExtensionAPI) {
  const failed: SessionCompactFailedEvent[] = [];
  pi.on("session_before_compact", ({ customInstructions }) =>
    customInstructions === "cancel" ? { cancel: true } : undefined,
  );
  pi.on("session_compact_failed", (event) => void failed.push(event));
  pi.on("session_shutdown", () => pi.appendEntry("failed", failed));
}
