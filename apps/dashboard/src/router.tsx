import { QueryClientProvider } from "@tanstack/solid-query";
import { createRouter } from "@tanstack/solid-router";

import { DefaultCatchBoundary } from "./components/DefaultCatchBoundary.tsx";
import { NotFound } from "./components/NotFound.tsx";
import { createQueryClient, forgetReadsOnSessionChange } from "./query.ts";
import { routeTree } from "./routeTree.gen.ts";

export function getRouter() {
  const queryClient = createQueryClient();
  const router = createRouter({
    routeTree,
    context: { queryClient, sessionSeen: forgetReadsOnSessionChange(queryClient) },
    // Every page, and every route's component, has the client.
    Wrap: (props) => (
      <QueryClientProvider client={queryClient}>{props.children}</QueryClientProvider>
    ),
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
