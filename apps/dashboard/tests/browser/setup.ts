import { vi } from "vite-plus/test";

// What the tests' document needs before the app's modules load, as a setup file.

// The page's network, as spies a test's fixture gives its answers to: the app's clients take
// `fetch` when their modules load. Until a fixture answers, a request goes to the network.
vi.spyOn(globalThis, "fetch");
vi.spyOn(globalThis, "WebSocket");

// The app's document, which Solid cannot create in a document that exists already.
vi.mock(import("../../src/components/RootDocument.tsx"), () => import("./RootDocument.tsx"));
