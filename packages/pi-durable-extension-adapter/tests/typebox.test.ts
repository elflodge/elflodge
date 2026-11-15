import { realpathSync } from "node:fs";
import { findPackageJSON } from "node:module";

import { expect, test } from "vite-plus/test";

// The package's TypeBox is the coding agent's own copy, so installing the package adds none beside
// it, and its runtime, which the bundle resolves to the coding agent's copy, is checked against
// the version it runs on.
test("the package takes TypeBox at the version the coding agent pins", () => {
  const own = findPackageJSON("typebox", import.meta.resolve("../src/prepare.ts"));
  const pis = findPackageJSON("typebox", import.meta.resolve("@earendil-works/pi-coding-agent"));
  if (own === undefined || pis === undefined) throw new Error("TypeBox is not installed");
  expect(realpathSync(own)).toBe(realpathSync(pis));
});
