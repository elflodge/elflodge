import { vi } from "vite-plus/test";

import { pageNetwork } from "./network.ts";

// What the tests' document needs before the app's modules load, as a setup file.

// The page's network, which a test's fixture answers: the app's clients take `fetch` when their
// modules load.
pageNetwork.enable();

// The app's document, which Solid cannot create in a document that exists already.
vi.mock(import("../../src/components/RootDocument.tsx"), () => import("./RootDocument.tsx"));
