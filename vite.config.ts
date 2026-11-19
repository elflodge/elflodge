import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    // Off by default in Oxfmt; on, so import order is the formatter's, not a review point.
    sortImports: true,
    // release-please writes these in its own style, and its release PR must pass checks: the changelog
    // in its Markdown, and the plugin manifest, whose version it bumps, rewritten as JSON.stringify
    // writes it, one array item per line. Oxfmt keeps package.json files in that style, but its
    // overrides cannot choose it for another file, as Prettier's `json-stringify` parser can.
    // The dashboard's route tree, which TanStack Router generates in its own style; its docs advise
    // keeping it out of formatters and linters.
    ignorePatterns: [
      "CHANGELOG.md",
      "skills/.claude-plugin/plugin.json",
      "apps/dashboard/src/routeTree.gen.ts",
    ],
  },
  staged: {
    "*": "vp check --fix",
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    categories: { correctness: "error", suspicious: "error" },
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      // An assertion that narrows is a claim the compiler cannot check; parse or narrow instead.
      "typescript/no-unsafe-type-assertion": "error",
      "typescript/no-non-null-assertion": "error",
      // Zod Mini names its default wrapper `_default`, and Zod Core exposes schema definitions via `_zod`.
      "no-underscore-dangle": ["error", { allow: ["_default", "_zod"] }],
    },
    overrides: [
      {
        // A pending timer keeps a Durable Object from hibernating, so it is billed for as long as the
        // Runner stays connected; see RunnerConnection.
        files: ["apps/hub/src/runner-connection.ts"],
        rules: {
          "no-restricted-globals": [
            "error",
            ...["setTimeout", "setInterval"].map((name) => ({
              name,
              message:
                "Timers keep RunnerConnection from hibernating; it schedules nothing itself, Runners' syncs bring the work.",
            })),
          ],
        },
      },
    ],
    options: { typeAware: true, typeCheck: true },
    // Extensions as their authors write them, importing Pi's packages under the names Pi's loader
    // accepts, former ones included, which the workspace does not install.
    ignorePatterns: [
      "packages/pi-durable-extension-adapter/tests/fixtures/**",
      "apps/hub/tests/fixtures/extensions/extension/**",
      // TanStack Router's generated route tree, as for the formatter.
      "apps/dashboard/src/routeTree.gen.ts",
    ],
  },
  run: {
    cache: true,
  },
});
