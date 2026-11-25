import type { QueryClient } from "@tanstack/solid-query";
import { createRootRouteWithContext } from "@tanstack/solid-router";

import { DefaultCatchBoundary } from "../components/DefaultCatchBoundary.tsx";
import { RootDocument } from "../components/RootDocument.tsx";
import { logoDark, logoLight } from "../logo.ts";
import { PRODUCT } from "../page-title.ts";

import appCss from "../styles/app.css?url";
// The two faces are linked from here, not imported by app.css: the build's notices list the packages
// that modules import, and the faces' licence asks to travel with them.
import sansCss from "@fontsource-variable/instrument-sans/wght.css?url";
import monoCss from "@fontsource-variable/jetbrains-mono/wght.css?url";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charset: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: PRODUCT },
    ],
    links: [
      { rel: "stylesheet", href: sansCss },
      { rel: "stylesheet", href: monoCss },
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: logoLight, media: "(prefers-color-scheme: light)" },
      { rel: "icon", href: logoDark, media: "(prefers-color-scheme: dark)" },
    ],
  }),
  errorComponent: DefaultCatchBoundary,
  shellComponent: RootDocument,
});
