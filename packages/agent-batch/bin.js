#!/usr/bin/env node
// The package's name before Elflodge, kept so that `npx agent-batch` and installs of it keep
// working: it runs the elflodge command it depends on, at the same version.
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const manifest = createRequire(import.meta.url).resolve("elflodge/package.json");
await import(pathToFileURL(path.join(path.dirname(manifest), "dist/bin.mjs")).href);
