import { Link, Outlet, createFileRoute, redirect, useNavigate } from "@tanstack/solid-router";
import { Show, createSignal } from "solid-js";

import { api } from "../api-client.ts";
import { attemptAuth, authClient, failureMessage } from "../auth-client.ts";
import { logoDark, logoLight } from "../logo.ts";

// Every page but signing in and setting up is for a signed-in member. The session is read from the
// hub on each navigation, so a session that ended elsewhere, such as by a password change on
// another device, sends the member to sign in again.
export const Route = createFileRoute("/_signed-in")({
  beforeLoad: async ({ location }) => {
    const { data, error } = await authClient.getSession();
    if (error) throw new Error(failureMessage(error));
    if (!data) throw redirect({ to: "/sign-in", search: { redirect: location.href } });
    const organization = await api.organization.get();
    return { member: data.user, organization };
  },
  component: SignedIn,
});

function SignedIn() {
  const context = Route.useRouteContext();
  const navigate = useNavigate();
  const [error, setError] = createSignal<string>();
  const [pending, setPending] = createSignal(false);

  async function signOut() {
    const failure = await attemptAuth(() => authClient.signOut(), setPending);
    if (failure) {
      setError(failure);
      return;
    }
    await navigate({ to: "/sign-in" });
  }

  return (
    <>
      <header class="site-header">
        <Link to="/" class="brand">
          <picture>
            <source srcset={logoDark} media="(prefers-color-scheme: dark)" />
            <img src={logoLight} alt="" width="32" height="32" />
          </picture>
          Elflodge
        </Link>
        <span class="organization">{context().organization.name}</span>
        <nav aria-label="Main">
          {/* Served by the hub itself, outside the dashboard. */}
          <a href="/docs">API reference</a>
        </nav>
        <div class="member">
          <span>{context().member.email}</span>
          <Link to="/change-password">Change password</Link>
          <button type="button" disabled={pending()} onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
      <main>
        <Outlet />
      </main>
    </>
  );
}
