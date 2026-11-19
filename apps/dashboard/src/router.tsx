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
