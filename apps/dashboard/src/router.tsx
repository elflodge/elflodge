import { QueryClientProvider } from "@tanstack/solid-query";
import { createRouter } from "@tanstack/solid-router";

import { DefaultCatchBoundary } from "./components/DefaultCatchBoundary.tsx";
import { NotFound } from "./components/NotFound.tsx";
import { createQueryClient } from "./query.ts";
import { routeTree } from "./routeTree.gen.ts";

export function getRouter() {
  const queryClient = createQueryClient();
  const router = createRouter({
    routeTree,
    search: { strict: true },
    // Match the hub's query spelling: every value is text, and a repeated key is an ordered list.
    // The router's JSON default converts 2026, 1e3 and true. Its parseSearchWith helper runs
    // after qss converts primitives, and stringifySearchWith encodes one value per key.
    // Effect UrlParams adds 5.6 kB gzipped to a client that otherwise loads no Effect modules.
    // query-string adds 3.7 kB gzipped and a null case for a bare key, which here is empty text.
    parseSearch: (search) => {
      const params = new URLSearchParams(search);
      return Object.fromEntries(
        Array.from(new Set(params.keys()), (key) => {
          const values = params.getAll(key);
          return [key, values.length === 1 ? values[0] : values];
        }),
      );
    },
    stringifySearch: (search) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(search)) {
        for (const item of Array.isArray(value) ? value : [value]) {
          if (item !== undefined) params.append(key, String(item));
        }
      }
      return params.size ? `?${params}` : "";
    },
    context: { queryClient },
    // Every page, and every route's component, has the client.
    Wrap: (props) => (
      <QueryClientProvider client={queryClient}>{props.children}</QueryClientProvider>
    ),
    defaultPreload: "intent",
    // Preloaded route data is immediately stale. Query decides when to refresh page data.
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: DefaultCatchBoundary,
    defaultNotFoundComponent: () => <NotFound />,
    scrollRestoration: true,
  });

  return router;
}
