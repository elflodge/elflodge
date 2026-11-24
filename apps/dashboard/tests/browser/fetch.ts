/**
 * The page's `fetch`, which a running test answers. The app's clients take `fetch` when their
 * modules load, before any test runs, so it is put in place first, as a setup file, and a test's
 * fixture gives it the answers; outside a test, a request goes to the network as before. The
 * answers are held on `globalThis`, as Vitest loads a setup file as a module of its own.
 */
declare global {
  var dashboardTestResponder: typeof fetch | undefined;
}

/** Has `next` answer every `fetch` from now on, or the network again for `undefined`. */
export function respondWith(next: typeof fetch | undefined) {
  globalThis.dashboardTestResponder = next;
}

if (!("dashboardTestResponder" in globalThis)) {
  const network = globalThis.fetch.bind(globalThis);
  respondWith(undefined);
  globalThis.fetch = (input, init) => (globalThis.dashboardTestResponder ?? network)(input, init);
}
