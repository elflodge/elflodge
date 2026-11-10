import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    deps: { neverBundle: ["pi-extension-loader"] },
    // The worker modules start by path from the entry, and the runtime is bundled with the
    // extensions when they are prepared, so each is a file of its own; only the entry is exported.
    entry: ["src/index.ts", "src/host-worker.ts", "src/prepare-process.ts", "src/runtime.ts"],
    dts: true,
    // In the workspace the export points to the source, as the other packages' do (ADR 0006).
    exports: {
      devExports: "@elflodge/source",
      exclude: ["host-worker", "prepare-process", "runtime"],
    },
  },
});
