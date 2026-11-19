import { QueryClientProvider } from "@tanstack/solid-query";
import { createRouter, defaultParseSearch, stringifySearchWith } from "@tanstack/solid-router";

import { DefaultCatchBoundary } from "./components/DefaultCatchBoundary.tsx";
import { NotFound } from "./components/NotFound.tsx";
import { createQueryClient } from "./query.ts";
import { routeTree } from "./routeTree.gen.ts";

export function getRouter() {
  const queryClient = createQueryClient();
  const router = createRouter({
    routeTree,
    // Batch IDs compare as text. JSON decoding would turn the ID 1e3 into the number 1000.
    parseSearch: (search) => {
      const filters = defaultParseSearch(search);
      if ("batchId" in filters) filters.batchId = new URLSearchParams(search).get("batchId");
      return filters;
    },
    stringifySearch: stringifySearchWith(JSON.stringify),
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
