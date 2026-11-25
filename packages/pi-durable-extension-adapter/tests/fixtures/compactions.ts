import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// An extension that writes a compaction's summary itself when asked to keep its own, with details
// it reads back later, as custom compaction extensions do, and does not listen to
// `session_compact`. At the end of the session it saves the compaction entries its session shows.
export default function extension(pi: ExtensionAPI) {
  pi.on("session_before_compact", ({ customInstructions, preparation }) => {
    if (customInstructions !== "keep mine") return undefined;
    const { firstKeptEntryId, tokensBefore } = preparation;
    return {
      compaction: { summary: "Mine.", firstKeptEntryId, tokensBefore, details: { mine: true } },
    };
  });
  pi.on("session_shutdown", (_event, ctx) =>
    pi.appendEntry(
      "compactions",
      ctx.sessionManager.getEntries().filter((entry) => entry.type === "compaction"),
    ),
  );
}
