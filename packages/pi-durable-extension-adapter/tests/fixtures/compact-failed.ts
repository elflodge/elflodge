import type { ExtensionAPI, SessionCompactFailedEvent } from "@earendil-works/pi-coding-agent";

// An extension that cancels a compaction when asked to, and records the compactions it is told
// failed, each with the end of a turn or run it came after, which it saves at the end of the
// session.
export default function extension(pi: ExtensionAPI) {
  const failed: (SessionCompactFailedEvent & { after: string })[] = [];
  let after = "start";
  for (const type of ["turn_end", "agent_end", "agent_settled"] as const) {
    pi.on(type, () => void (after = type));
  }
  pi.on("session_before_compact", ({ customInstructions }) =>
    customInstructions === "cancel" ? { cancel: true } : undefined,
  );
  pi.on("session_compact_failed", (event) => void failed.push({ after, ...event }));
  pi.on("session_shutdown", () => pi.appendEntry("failed", failed));
}
