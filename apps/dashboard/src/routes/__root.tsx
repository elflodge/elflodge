import type { JSX } from "@solidjs/web";
import { HeadContent, Scripts, createRootRoute } from "@tanstack/solid-router";

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
  notFoundComponent: () => <NotFound />,
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
