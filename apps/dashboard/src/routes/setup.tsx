import { ORPCError } from "@orpc/client";
import { Link, createFileRoute, redirect, useLocation, useNavigate } from "@tanstack/solid-router";
import { Show, createSignal } from "solid-js";

import { api, apiFailureMessage, readApi } from "../api-client.ts";
import { attemptAuth, authClient } from "../auth-client.ts";
import { BrandMark } from "../components/BrandMark.tsx";
import { Notice } from "../components/Notice.tsx";
import { GIVEN_NAME, NEW_PASSWORD, fieldText } from "../form.ts";

// Setting up a new hub: creating its owner with the setup link the hub printed (ADR 0015). The
// link's token comes after `#`, so it never reaches the hub's request logs.
export const Route = createFileRoute("/setup")({
  loader: async () => {
    const { needed } = await readApi("Whether the hub is set up", () => api.setup.get());
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
    const name = fieldText(form, "name");
    setPending(true);
    try {
      await api.setup.complete({ token: token(), organizationName, name, ...owner });
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
    setError(`The owner was created, but signing in failed: ${signInFailure.message}`);
    setAlreadySetUp(true);
  }

  return (
    <main id="main" class="page is-alone">
      <BrandMark alt="" />
      <h1>Set up Elflodge</h1>
      <Show
        when={!alreadySetUp()}
        fallback={
          <>
            <Show when={error()}>{(message) => <Notice role="alert">{message()}</Notice>}</Show>
            <p class="prose">
              This hub is set up. <Link to="/sign-in">Sign in</Link>
            </p>
          </>
        }
      >
        <Show
          when={token()}
          fallback={
            <p class="prose">
              Open the setup link the hub printed when it started. For a hub in Docker,{" "}
              <code>docker compose logs hub</code> shows it; for a hub on Workers,{" "}
              <code>vp run setup</code> prints one.
            </p>
          }
        >
          <p class="prose">
            Create the hub's owner, who manages its members, API keys and Runners.
          </p>
          <form class="fields" onSubmit={createOwner}>
            <div class="field">
              <label for="setup-organization">Organization name</label>
              <input
                id="setup-organization"
                name="organization"
                autocomplete="organization"
                required
                {...GIVEN_NAME}
              />
            </div>
            <div class="field">
              <label for="setup-name">Your name</label>
              <input id="setup-name" name="name" autocomplete="name" required {...GIVEN_NAME} />
            </div>
            <div class="field">
              <label for="setup-email">Email</label>
              <input id="setup-email" name="email" type="email" autocomplete="username" required />
            </div>
            <div class="field">
              <label for="setup-password">Password</label>
              <input
                id="setup-password"
                name="password"
                type="password"
                autocomplete="new-password"
                required
                {...NEW_PASSWORD}
              />
            </div>
            <Show when={error()}>{(message) => <Notice role="alert">{message()}</Notice>}</Show>
            <button type="submit" class="primary" disabled={pending()}>
              Create owner
            </button>
          </form>
        </Show>
      </Show>
    </main>
  );
}
