import { FetchInterceptor } from "@mswjs/interceptors/fetch";
import { WebSocketInterceptor } from "@mswjs/interceptors/WebSocket";
import { defineNetwork, InterceptorSource } from "msw/experimental";
import { http } from "msw/http";

/**
 * The page's network, as Mock Service Worker intercepts it in the document the tests run in, without
 * a worker: its `fetch` and `WebSocket`, which a test's fixture answers through a handler of its
 * own. `setup.ts` enables it before the app's modules load. Outside a test nothing answers a
 * request, and a WebSocket fails, as MSW errors a connection no handler takes.
 */
export const pageNetwork = defineNetwork({
  sources: [
    new InterceptorSource({ interceptors: [new FetchInterceptor(), new WebSocketInterceptor()] }),
  ],
  handlers: [http.all("*", never)],
  onUnhandledFrame: "error",
  // MSW otherwise prints each request and its answer to the console, which tests read.
  context: { quiet: true },
});

/** What never settles, so nothing waiting for it goes on. */
export function never() {
  return new Promise<never>(() => {});
}
