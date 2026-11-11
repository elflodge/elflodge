import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    deps: { neverBundle: ["pi-extension-loader"] },
    // The worker modules start by path from the entry, and the runtime is bundled with the
    // extensions when they are prepared, so each is a file of its own; only the entry is exported.
    entry: ["src/index.ts", "src/host-worker.ts", "src/prepare-process.ts", "src/runtime.ts"],
    dts: true,
    // In the workspace the source is exported under a condition of its own, which the Runner's and
    // the hub's settings add, and the build otherwise: `pnpm deploy` copies this manifest into the
    // Runner's image without applying `publishConfig`, and the image loads the build (ADR 0006).
    // TODO: Recheck when pnpm deploy applies workspace dependencies' publishConfig:
    // https://github.com/pnpm/pnpm/pull/7647
    exports: {
      devExports: "@elflodge/source",
      exclude: ["host-worker", "prepare-process", "runtime"],
    },
  },
});
