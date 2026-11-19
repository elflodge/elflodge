import { createRouter } from "@tanstack/solid-router";

import { DefaultCatchBoundary } from "./components/DefaultCatchBoundary.tsx";
import { NotFound } from "./components/NotFound.tsx";
import { createSessionQueries } from "./query.ts";
import { routeTree } from "./routeTree.gen.ts";

export function getRouter() {
  const router = createRouter({
    routeTree,
    context: { queries: createSessionQueries() },
    defaultPreload: "intent",
    // A loader runs on every preload and navigation, and Query decides whether what it holds is
    // still fresh (src/query.ts).
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: DefaultCatchBoundary,
    defaultNotFoundComponent: () => <NotFound />,
    scrollRestoration: true,
  });

  return router;
}
