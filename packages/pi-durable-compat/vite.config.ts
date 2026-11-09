import { fileURLToPath } from "node:url";

import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "pi-extension-loader": fileURLToPath(
        new URL(
          "./core/extensions/loader.js",
          import.meta.resolve("@earendil-works/pi-coding-agent"),
        ),
      ),
    },
  },
  pack: {
    deps: { neverBundle: ["pi-extension-loader"] },
    // The worker modules start by path from the entry, and the runtime is bundled with the
    // extensions when they are prepared, so each is a file of its own; only the entry is exported.
    entry: ["src/index.ts", "src/host-worker.ts", "src/prepare-worker.ts", "src/runtime.ts"],
    dts: true,
    // In the workspace the export points to the source, as the other packages' do (ADR 0006).
    exports: { devExports: true, exclude: ["host-worker", "prepare-worker", "runtime"] },
  },
});
