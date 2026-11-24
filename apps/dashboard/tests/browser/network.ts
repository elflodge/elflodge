import { vi } from "vite-plus/test";

// The page's network, as spies a test's fixture gives its answers to. The app's clients take
// `fetch` when their modules load, before any test runs, so both are put in place first, as a setup
// file; until a fixture answers, a request goes to the network.
vi.spyOn(globalThis, "fetch");
vi.spyOn(globalThis, "WebSocket");
