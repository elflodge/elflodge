import { Link, Outlet, createFileRoute, redirect, useRouter } from "@tanstack/solid-router";
import { Button } from "@ui-sdk/solid/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  createPopoverController,
} from "@ui-sdk/solid/popover";
import { Show, createSignal, onSettled } from "solid-js";

import { hubFailureMessage, readFromHub } from "../api-client.ts";
import { getSession } from "../auth-client.ts";
import { BrandMark } from "../components/BrandMark.tsx";
import { CurrentDestination, Destinations } from "../components/Destinations.tsx";
import { InShell } from "../components/FallbackPage.tsx";
import { HubStrip } from "../components/HubStrip.tsx";
import { Notice } from "../components/Notice.tsx";
import {
  reloadAndWaitIfMemberChanged,
  signOutTo,
  watchDocumentMember,
} from "../member-document.ts";

// The shell is for a signed-in user. The session is read from the
// hub on each navigation, so a session that ended elsewhere, such as by a password change on
// another device, sends the user to sign in again.
export const Route = createFileRoute("/_signed-in")({
  beforeLoad: async ({ location }) => {
    const session = await readFromHub("The session", getSession);
    await reloadAndWaitIfMemberChanged(session?.user.id ?? null);
    if (!session) throw redirect({ to: "/sign-in", search: { redirect: location.href } });
    return { user: session.user, membership: session.membership };
  },
  // Pending routes lose beforeLoad context (TanStack/router#8115). Keep the last completed
  // session visible and publish each check because membership can change for the same user.
  // Once Solid Start includes TanStack/router#8964, move the shell and _member from this loader
  // back to route context together, then remove the loader.
  shouldReload: true,
  loader: {
    staleReloadMode: "blocking",
    handler: ({ context: { user, membership } }) => ({ user, membership }),
  },
  component: SignedIn,
});

function SignedIn() {
  const session = Route.useLoaderData();
  const memberOrganization = () => {
    const { membership } = session();
    return membership.status === "member" ? membership.organization : undefined;
  };
  const router = useRouter();
  onSettled(() => watchDocumentMember(session().user.id));
  const [error, setError] = createSignal<string>();
  const menu = createPopoverController();
  const [barEnd, setBarEnd] = createSignal<HTMLDivElement>();

  // Following the current link also resolves a navigation. Opening another tab leaves this menu open.
  onSettled(() => router.subscribe("onResolved", () => menu.close()));

  async function signOut() {
    try {
      await signOutTo(router.buildLocation({ to: "/sign-in" }).publicHref);
    } catch (failure) {
      // Close the menu to reveal the notice. The menu returns focus to the member's name if it
      // still holds it; a member who moved on has already closed it.
      menu.close();
      setError(hubFailureMessage(failure));
    }
  }

  return (
    <>
      <a class="skip" href="#main">
        Skip to the page
      </a>
      <header class="topbar">
        <Link to="/" class="brand">
          <BrandMark alt="Elflodge" />
          <span class="brand-name" aria-hidden="true">
            Elflodge
          </span>
        </Link>
        {/* Removing a member leaves their session, which then has no Organization to name. */}
        {/* Read directly: a keyed child would be rebuilt on each read of the session, dropping
            the tooltip of its title. */}
        <Show when={memberOrganization()}>
          <span class="org" title={memberOrganization()?.name}>
            {memberOrganization()?.name}
          </span>
        </Show>
        <nav class="nav-wide" aria-label="Destinations">
          <Destinations class="nav" />
        </nav>
        <CurrentDestination />
        <div class="topbar-end" ref={setBarEnd}>
          <Popover controller={menu}>
            <PopoverTrigger class="quiet">
              <span class="member-name" title={session().user.name}>
                {session().user.name}
              </span>
              <span class="mark mark-opens" aria-hidden="true" />
            </PopoverTrigger>
            {/* Placed under the bar's end rather than the bar, which spans the window: the end stops at
                the page's gutter, which grows with the window, and a pixel offset along the bar could
                not follow it. The end stretches to the bar's height, so 6px is the bar's 2px rule and
                --space-1 below it. Opening leaves focus on the member's name, so Tab goes on to the
                first link. Having no title, the menu is named by the member's name. Kept mounted while
                closed, so that a pending Sign out stays pending, and refuses another press, when the
                menu is closed and opened again. */}
            <PopoverContent
              class="menu-pop"
              anchor={barEnd()}
              align="end"
              sideOffset={6}
              collisionPadding={8}
              initialFocus="none"
              keepMounted
            >
              <nav class="pop-nav" aria-label="Destinations">
                <Destinations class="nav-stack" />
              </nav>
              <p class="pop-who">
                <strong>{session().user.name}</strong>
                <br />
                {/* In the mono, as what a person may copy. The sans also draws a full stop close into
                    a round letter beside it, which closes up an address such as "pine.example". */}
                <span class="mono">{session().user.email}</span>
                <Show when={memberOrganization()} keyed>
                  {(organization) => (
                    <>
                      <br />
                      {organization.name}
                    </>
                  )}
                </Show>
              </p>
              <ul class="pop-list">
                <li>
                  <Link to="/change-password">Change password</Link>
                </li>
                <li>
                  <Button class="quiet" onClick={signOut} pendingAnnouncement="Working…">
                    Sign out
                  </Button>
                </li>
              </ul>
            </PopoverContent>
          </Popover>
        </div>
      </header>
      {/* What the hub says now of the Organization's jobs, which are not a removed member's. */}
      <Show when={memberOrganization()}>
        <HubStrip />
      </Show>
      <main id="main" class="page">
        <Show when={error()} keyed>
          {(message) => <Notice role="alert">{message}</Notice>}
        </Show>
        <InShell value={true}>
          <Outlet />
        </InShell>
      </main>
    </>
  );
}
