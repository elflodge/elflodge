import type { JSX } from "@solidjs/web";
import { ClientOnly, HeadContent, Scripts, createRootRoute } from "@tanstack/solid-router";

import { DefaultCatchBoundary } from "../components/DefaultCatchBoundary.tsx";
import { NotFound } from "../components/NotFound.tsx";
import { logoDark, logoLight } from "../logo.ts";

import appCss from "../styles/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charset: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Elflodge" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: logoLight, media: "(prefers-color-scheme: light)" },
      { rel: "icon", href: logoDark, media: "(prefers-color-scheme: dark)" },
    ],
  }),
  errorComponent: DefaultCatchBoundary,
  // The shell the hub serves at every address renders this route alone, with nothing in its outlet.
  // At an address no route matches, the router renders the not-found page in that outlet during
  // hydration, which finds no nodes for it in the shell: Solid creates them but never attaches them,
  // and the page stays blank. ClientOnly renders it once hydration is done, as the router does for
  // the routes the shell leaves out. TanStack/router#8473 is the same mismatch in React, where
  // ClientOnly does not help, since React fails on the mismatch itself. This can go once the router
  // holds the root's not-found page back during hydration, as that issue asks.
  notFoundComponent: () => (
    <ClientOnly>
      <NotFound />
    </ClientOnly>
  ),
  shellComponent: RootDocument,
});

function RootDocument(props: { children: JSX.Element }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {props.children}
        <Scripts />
      </body>
    </html>
  );
}
