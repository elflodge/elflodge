import { ORPCError } from "@orpc/client";
import { Link, createFileRoute, redirect, useLocation, useNavigate } from "@tanstack/solid-router";
import { Show, createSignal } from "solid-js";

import { api, apiFailureMessage } from "../api-client.ts";
import { attemptAuth, authClient } from "../auth-client.ts";
import { fieldText } from "../form.ts";

// Setting up a new hub: creating its owner with the setup link the hub printed (ADR 0015). The
// link's token comes after `#`, so it never reaches the hub's request logs.
export const Route = createFileRoute("/setup")({
  loader: async () => {
    const { needed } = await api.setup.get();
    if (!needed) throw redirect({ to: "/sign-in" });
  },
  component: Setup,
});

function Setup() {
  const navigate = useNavigate();
  // Read from the router, so a link opened over this page, which changes only its hash, counts.
  const token = useLocation({ select: (location) => location.hash });
  const [error, setError] = createSignal<string>();
  const [alreadySetUp, setAlreadySetUp] = createSignal(false);
  const [pending, setPending] = createSignal(false);

  async function createOwner(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
    event.preventDefault();
    setError(undefined);
    const form = new FormData(event.currentTarget);
    const organizationName = fieldText(form, "organization");
    const owner = { email: fieldText(form, "email"), password: fieldText(form, "password") };
    setPending(true);
    try {
      await api.setup.complete({ token: token(), organizationName, ...owner });
    } catch (failure) {
      if (failure instanceof ORPCError && failure.code === "CONFLICT") setAlreadySetUp(true);
      else setError(apiFailureMessage(failure));
      return;
    } finally {
      setPending(false);
    }
    const signInFailure = await attemptAuth(() => authClient.signIn.email(owner), setPending);
    if (signInFailure === undefined) {
      await navigate({ to: "/" });
      return;
    }
    // The owner exists, so the form is done with; the sign-in page can try again.
    setError(`The owner was created, but signing in failed: ${signInFailure}`);
    setAlreadySetUp(true);
  }

  return (
    <main class="sign-in">
      <h1>Set up Elflodge</h1>
      <Show
        when={!alreadySetUp()}
        fallback={
          <>
            <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
            <p>
              This hub is set up. <Link to="/sign-in">Sign in</Link>
            </p>
          </>
        }
      >
        <Show
          when={token()}
          fallback={
            <p>
              Open the setup link the hub printed when it started. For a hub in Docker,{" "}
              <code>docker compose logs hub</code> shows it; for a hub on Workers,{" "}
              <code>vp run setup</code> prints one.
            </p>
          }
        >
          <p>Create the hub's owner, who manages its members, API keys and Runners.</p>
          <form onSubmit={createOwner}>
            <label>
              Organization name
              <input name="organization" autocomplete="organization" required />
            </label>
            <label>
              Email
              <input name="email" type="email" autocomplete="username" required />
            </label>
            <label>
              Password
              <input name="password" type="password" autocomplete="new-password" required />
            </label>
            <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
            <button type="submit" disabled={pending()}>
              Create owner
            </button>
          </form>
        </Show>
      </Show>
    </main>
  );
}
