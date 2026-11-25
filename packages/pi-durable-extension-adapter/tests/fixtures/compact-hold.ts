import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { basename } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// An extension whose `session_compact` handler takes a while, as one that drops its provider's open
// query after a compaction can: it holds until the test posts on the channel named after its
// working directory, then notes that it is done in the order log beside it.
export default function extension(pi: ExtensionAPI) {
  let released: Promise<unknown> = Promise.resolve();
  pi.on("session_start", (_event, ctx) => {
    const channel = new BroadcastChannel(`${basename(ctx.cwd)}.compact`);
    // It keeps no worker from exiting.
    channel.unref();
    // Listening from the start, so a word posted before the compaction is not missed.
    released = once(channel, "message").finally(() => channel.close());
  });
  pi.on("session_compact", async (_event, ctx) => {
    await released;
    appendFileSync(`${ctx.cwd}.order`, "session_compact\n");
  });
}
