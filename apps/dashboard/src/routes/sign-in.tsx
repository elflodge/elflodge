import { createFileRoute, redirect, useNavigate } from "@tanstack/solid-router";
import { Show, createSignal } from "solid-js";

import { api } from "../api-client.ts";
import { attemptAuth, authClient } from "../auth-client.ts";
import { fieldText } from "../form.ts";

export const Route = createFileRoute("/sign-in")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    // Where to go after signing in, kept only as a path in the dashboard, so that a link cannot send
    // a member to another site once signed in.
    redirect:
      typeof search.redirect === "string" && search.redirect.startsWith("/")
        ? search.redirect
        : undefined,
  }),
  // A hub without an owner has no one to sign in; setting it up comes first.
  loader: async () => {
    const { needed } = await api.setup.get();
    if (needed) throw redirect({ to: "/setup" });
  },
  component: SignIn,
});

function SignIn() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [error, setError] = createSignal<string>();
  const [pending, setPending] = createSignal(false);

  async function signIn(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const failure = await attemptAuth(
      () =>
        authClient.signIn.email({
          email: fieldText(form, "email"),
          password: fieldText(form, "password"),
        }),
      setPending,
    );
    if (failure) {
      setError(failure);
      return;
    }
    const target = search().redirect;
    await (target === undefined ? navigate({ to: "/" }) : navigate({ href: target }));
  }

  return (
    <main class="sign-in">
      <h1>Sign in to Elflodge</h1>
      <form onSubmit={signIn}>
        <label>
          Email
          <input name="email" type="email" autocomplete="username" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autocomplete="current-password" required />
        </label>
        <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
        <button type="submit" disabled={pending()}>
          Sign in
        </button>
      </form>
    </main>
  );
}
