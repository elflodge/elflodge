import { Link, Outlet, createFileRoute, redirect, useNavigate } from "@tanstack/solid-router";
import { Show, createSignal, onSettled } from "solid-js";

import { answered, attemptAuth, authClient, failureMessage, unreadError } from "../auth-client.ts";
import { BrandMark } from "../components/BrandMark.tsx";
import { Destinations } from "../components/Destinations.tsx";
import { InShell } from "../components/FallbackPage.tsx";
import { HubStrip } from "../components/HubStrip.tsx";
import { Notice } from "../components/Notice.tsx";

// Every page but signing in and setting up is for a signed-in member. The session is read from the
// hub on each navigation, so a session that ended elsewhere, such as by a password change on
// another device, sends the member to sign in again.
export const Route = createFileRoute("/_signed-in")({
  beforeLoad: async ({ context, location, preload, abortController }) => {
    const { data, error } = await answered(authClient.getSession());
    // A 401, as when the session was deleted while being renewed, says no one is signed in, as
    // __root.tsx reads it too; any other failure says nothing of who is.
    if (error && error.status !== 401) throw unreadError("The session", failureMessage(error));
    // Before any loader warms the cache: what was read for another member is forgotten first. Not
    // by a navigation another has replaced, which the router aborts, as its answer may be older
    // than the one the other reads. Nor by a preload, which shows nothing: the router documents no
    // way for one to stop short, so its loaders may warm the cache with the next member's reads
    // while it still holds the last one's. The navigation that would show them forgets them all
    // first, and the hub answers every read for the member its cookie names anyway.
    if (!preload && !abortController.signal.aborted) context.memberSeen(data?.user.id ?? null);
    if (!data) throw redirect({ to: "/sign-in", search: { redirect: location.href } });
    // One Organization per deployment (ADR 0007), so it is the one every member's list holds.
    const organizations = await answered(authClient.organization.list());
    if (organizations.error) {
      throw unreadError("The Organization", failureMessage(organizations.error));
    }
    // Removing a member leaves their session, which then lists no Organization.
    return { member: data.user, organization: organizations.data[0] };
  },
  component: SignedIn,
});

function SignedIn() {
  const context = Route.useRouteContext();
  const navigate = useNavigate();
  const [error, setError] = createSignal<string>();
  const [pending, setPending] = createSignal(false);
  let account: HTMLDivElement | undefined;
  let opener: HTMLButtonElement | undefined;

  function closeMenu() {
    if (account?.matches(":popover-open")) account.hidePopover();
  }

  /** Whether `node` is the menu or the button that opens it, or is inside one of them. */
  function inMenuGroup(node: EventTarget | null) {
    return node instanceof Node && Boolean(opener?.contains(node) || account?.contains(node));
  }

  // The browser closes the menu on Escape or a press elsewhere, but not when the keyboard goes
  // elsewhere, and the menu would then cover the page the keyboard is in. So it closes when the
  // focus arrives outside the menu and its button. Where the focus arrives is watched, not where
  // it leaves from, so that the menu stays open while the focus is nowhere in the page: after a
  // press on the menu's own text, or after Tab from the page's last control.
  function closeWhenFocusArrivesElsewhere(event: FocusEvent) {
    if (!inMenuGroup(event.target)) closeMenu();
  }
  onSettled(() => {
    document.addEventListener("focusin", closeWhenFocusArrivesElsewhere);
    return () => document.removeEventListener("focusin", closeWhenFocusArrivesElsewhere);
  });

  async function signOut() {
    const failure = await attemptAuth(() => authClient.signOut(), setPending);
    if (failure) {
      // The notice is in the page, which the open menu would cover. The focus goes to the menu's
      // button when it is still in the menu or is nowhere, as it is once the button pressed has
      // been disabled. A member who has moved on meanwhile keeps their place.
      const focused = document.activeElement;
      closeMenu();
      if (!focused || focused === document.body || inMenuGroup(focused)) opener?.focus();
      setError(failure.message);
      return;
    }
    await navigate({ to: "/sign-in" });
  }

  return (
    // Keyed, so that another member's shell is drawn anew: a component still mounted would go on
    // showing what it last read for the member before, even after the cache forgot it. Until the
    // router has loaded the page for the member the hub now names, which a slow read can delay,
    // the shell of the one before shows nothing.
    <Show when={context().member.id} keyed>
      {(_memberId) => (
        <Show
          when={
            context().confirmedMember() === undefined ||
            context().confirmedMember() === context().member.id
          }
        >
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
            <Show when={context().organization}>
              {(organization) => (
                <span class="org" title={organization().name}>
                  {organization().name}
                </span>
              )}
            </Show>
            <nav class="nav-wide" aria-label="Destinations">
              <Destinations class="nav" />
            </nav>
            <div class="topbar-end">
              <button
                type="button"
                class="quiet"
                popovertarget="account"
                ref={(element) => {
                  opener = element;
                }}
              >
                <span class="member-name" title={context().member.name}>
                  {context().member.name}
                </span>
                <span class="mark mark-opens" aria-hidden="true" />
              </button>
              {/* A native popover: the browser opens it, and closes it on Escape or a press elsewhere. */}
              <div
                id="account"
                class="menu-pop"
                popover
                ref={(element) => {
                  account = element;
                }}
              >
                {/* At narrow widths the destinations fold into the menu. The router changes the page
                    without loading it anew, which would leave the menu open. */}
                <nav class="pop-nav" aria-label="Destinations">
                  <Destinations class="nav-stack" onFollow={closeMenu} />
                </nav>
                <p class="pop-who">
                  <strong>{context().member.name}</strong>
                  <br />
                  {/* In the mono, as what a person may copy. The sans also draws a full stop close into
                  a round letter beside it, which closes up an address such as "pine.example". */}
                  <span class="mono">{context().member.email}</span>
                  <Show when={context().organization}>
                    {(organization) => (
                      <>
                        <br />
                        {organization().name}
                      </>
                    )}
                  </Show>
                </p>
                <ul class="pop-list">
                  <li>
                    {/* The router changes the page without loading it anew, which would leave the menu open. */}
                    <Link to="/change-password" onClick={closeMenu}>
                      Change password
                    </Link>
                  </li>
                  <li>
                    {/* Served by the hub itself, outside the dashboard. */}
                    <a href="/docs">API reference</a>
                  </li>
                  <li>
                    <button
                      type="button"
                      class="quiet"
                      disabled={pending()}
                      onClick={() => void signOut()}
                    >
                      Sign out
                    </button>
                  </li>
                </ul>
              </div>
            </div>
          </header>
          {/* What the hub says now of the Organization's jobs, which are not a removed member's. */}
          <Show when={context().organization}>
            <HubStrip />
          </Show>
          <main id="main" class="page">
            <Show when={error()}>{(message) => <Notice role="alert">{message()}</Notice>}</Show>
            <InShell value={true}>
              <Outlet />
            </InShell>
          </main>
        </Show>
      )}
    </Show>
  );
}
