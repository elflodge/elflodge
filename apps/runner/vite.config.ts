import { defaultServerConditions, defineConfig } from "vite-plus";

export default defineConfig({
  // The extension adapter's source, under the condition its exports give it in the workspace
  // (ADR 0006); outside the workspace, Node loads its build.
  ssr: { resolve: { conditions: ["@elflodge/source", ...defaultServerConditions] } },
  run: {
    tasks: {
      // Not cached: Vite Task traces a cached task's file reads by preloading a library into every
      // process it starts (`LD_PRELOAD`), which the jobs' sandboxes cannot load, so their commands
      // would print its errors.
      test: { command: "vp test", cache: false },
    },
  },
  pack: {
    // The package exports its TypeScript source, like `contract` (ADR 0006); the build is only for
    // starting a Runner with `start`.
    entry: ["src/main.ts"],
    dts: false,
    // `contract` exports TypeScript source, which the built Runner must not have to load.
    deps: { alwaysBundle: ["contract"] },
  },
});
