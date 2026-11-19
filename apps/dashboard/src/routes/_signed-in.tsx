import { Link, Outlet, createFileRoute, redirect, useRouter } from "@tanstack/solid-router";
import { Show, createSignal, onSettled } from "solid-js";

import { apiFailureMessage, readApi } from "../api-client.ts";
import { authClient, getSession } from "../auth-client.ts";
import { BrandMark } from "../components/BrandMark.tsx";
import { CurrentDestination, Destinations } from "../components/Destinations.tsx";
import { InShell } from "../components/FallbackPage.tsx";
import { HubStrip } from "../components/HubStrip.tsx";
import { Notice } from "../components/Notice.tsx";
import { createFormAction } from "../form.ts";
import {
  reloadAndWaitIfMemberChanged,
  signOutTo,
  watchDocumentMember,
} from "../member-document.ts";

// Every page but signing in and setting up is for a signed-in member. The session is read from the
// hub on each navigation, so a session that ended elsewhere, such as by a password change on
// another device, sends the member to sign in again.
export const Route = createFileRoute("/_signed-in")({
  beforeLoad: async ({ location }) => {
    // Start both reads together, but act on the session first even if the Organization read fails.
    const organizations = Promise.allSettled([
      readApi("The Organization", () => authClient.organization.list()),
    ]);
    const session = await readApi("The session", getSession);
    await reloadAndWaitIfMemberChanged(session?.user.id ?? null);
    if (!session) throw redirect({ to: "/sign-in", search: { redirect: location.href } });
    // One Organization per deployment (ADR 0007), so it is the one every member's list holds.
    const [list] = await organizations;
    if (list.status === "rejected") throw list.reason;
    // Removing a member leaves their session, which then lists no Organization.
    return { member: session.user, organization: list.value[0] };
  },
  component: SignedIn,
});

function SignedIn() {
  const context = Route.useRouteContext();
  const router = useRouter();
  onSettled(() => watchDocumentMember(context().member.id));
  const [error, setError] = createSignal<string>();
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

  const { pending, onSubmit: signOut } = createFormAction(async () => {
    try {
      await signOutTo(router.buildLocation({ to: "/sign-in" }).publicHref);
    } catch (failure) {
      // The notice is in the page, which the open menu would cover. The focus goes to the menu's
      // button when it is still in the menu or is nowhere, as it is once the button pressed has
      // been disabled. A member who has moved on meanwhile keeps their place.
      const focused = document.activeElement;
      closeMenu();
      if (!focused || focused === document.body || inMenuGroup(focused)) opener?.focus();
      setError(apiFailureMessage(failure));
    }
  });

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
        <CurrentDestination />
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
                <form onSubmit={signOut}>
                  <button type="submit" class="quiet" disabled={pending()}>
                    Sign out
                  </button>
                </form>
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
    </>
  );
}
