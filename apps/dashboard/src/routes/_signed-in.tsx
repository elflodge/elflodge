import { Link, Outlet, createFileRoute, redirect, useNavigate } from "@tanstack/solid-router";
import { Show, createSignal } from "solid-js";

import { answered, attemptAuth, authClient, failureMessage, unreadError } from "../auth-client.ts";
import { BrandMark } from "../components/BrandMark.tsx";
import { InShell } from "../components/FallbackPage.tsx";
import { Notice } from "../components/Notice.tsx";

// Every page but signing in and setting up is for a signed-in member. The session is read from the
// hub on each navigation, so a session that ended elsewhere, such as by a password change on
// another device, sends the member to sign in again.
export const Route = createFileRoute("/_signed-in")({
  beforeLoad: async ({ location }) => {
    const { data, error } = await answered(authClient.getSession());
    if (error) throw unreadError("The session", failureMessage(error));
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

  // The browser closes the menu on Escape or a press elsewhere, but not when the keyboard leaves
  // it, and it would then cover the page the keyboard is in. The button and the menu are one group
  // for that, as the keyboard goes between them with the menu open.
  function closeWhenFocusLeaves(event: FocusEvent & { currentTarget: HTMLDivElement }) {
    const next = event.relatedTarget;
    if (next instanceof Node && !event.currentTarget.contains(next)) closeMenu();
  }

  async function signOut() {
    const failure = await attemptAuth(() => authClient.signOut(), setPending);
    if (failure) {
      // The notice is in the page, which the open menu would cover. The focus goes to the menu's
      // button: the one pressed lost it when it was disabled, so closing the menu returns it nowhere.
      closeMenu();
      opener?.focus();
      setError(failure);
      return;
    }
    await navigate({ to: "/sign-in" });
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
        <Show when={context().organization}>
          {(organization) => (
            <span class="org" title={organization().name}>
              {organization().name}
            </span>
          )}
        </Show>
        <div class="topbar-end" onFocusOut={closeWhenFocusLeaves}>
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
            <p class="pop-who">
              <strong>{context().member.name}</strong>
              <br />
              {context().member.email}
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
      <main id="main" class="page">
        <Show when={error()}>{(message) => <Notice role="alert">{message()}</Notice>}</Show>
        <InShell value={true}>
          <Outlet />
        </InShell>
      </main>
    </>
  );
}
