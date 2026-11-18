import { createRouter } from "@tanstack/solid-router";

import { DefaultCatchBoundary } from "./components/DefaultCatchBoundary.tsx";
import { NotFound } from "./components/NotFound.tsx";
import { routeTree } from "./routeTree.gen.ts";

export function getRouter() {
  const router = createRouter({
    routeTree,
    defaultPreload: "intent",
    defaultErrorComponent: DefaultCatchBoundary,
    defaultNotFoundComponent: () => <NotFound />,
    scrollRestoration: true,
  });

  return router;
}
