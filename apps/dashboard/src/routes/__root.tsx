import type { JSX } from "@solidjs/web";
import type { QueryClient } from "@tanstack/solid-query";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
  useRouter,
} from "@tanstack/solid-router";
import { onSettled } from "solid-js";

import { authClient } from "../auth-client.ts";
import { DefaultCatchBoundary } from "../components/DefaultCatchBoundary.tsx";
import { logoDark, logoLight } from "../logo.ts";

import appCss from "../styles/app.css?url";
// The two faces are linked from here, not imported by app.css: the build's notices list the packages
// that modules import, and the faces' licence asks to travel with them.
import sansCss from "@fontsource-variable/instrument-sans/wght.css?url";
import monoCss from "@fontsource-variable/jetbrains-mono/wght.css?url";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  sessionSeen: (sessionId: string | null) => boolean;
}>()({
  head: () => ({
    meta: [
      { charset: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Elflodge" },
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
  component: Root,
});

/**
 * Every page, following the session as Better Auth's client sees it change: signed out in another
 * tab, which it hears of, or here. What was read is then forgotten, and the router loads the page
 * again, which sends a member signed out to sign in, or shows the one signed in now. A sign-in in
 * another tab it does not hear of; the next navigation finds it (`_signed-in`).
 */
function Root() {
  const router = useRouter();
  const context = Route.useRouteContext();
  // Better Auth's client reads the session, and listens for changes, only while something
  // subscribes, which this does for the tab's life.
  onSettled(() =>
    authClient.useSession.subscribe((session) => {
      // Only settled answers: a read under way, or one that failed, does not say who is signed in.
      if (session.isPending || session.isRefetching || (session.error && session.data)) return;
      if (context().sessionSeen(session.data?.session.id ?? null)) void router.invalidate();
    }),
  );
  return <Outlet />;
}

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
