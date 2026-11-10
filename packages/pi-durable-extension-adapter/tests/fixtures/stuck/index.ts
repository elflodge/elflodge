import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// An extension whose `session_start` handler never finishes.
export default function extension(pi: ExtensionAPI) {
  pi.on("session_start", () => new Promise<never>(() => {}));
}
