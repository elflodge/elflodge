import { createFileRoute, redirect, useNavigate } from "@tanstack/solid-router";
import { Show, createSignal } from "solid-js";

import { api, readApi } from "../api-client.ts";
import { attemptAuth, authClient } from "../auth-client.ts";
import { BrandMark } from "../components/BrandMark.tsx";
import { Notice } from "../components/Notice.tsx";
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
    const { needed } = await readApi("Whether the hub is set up", () => api.setup.get());
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
      setError(failure.message);
      return;
    }
    const target = search().redirect;
    await (target === undefined ? navigate({ to: "/" }) : navigate({ href: target }));
  }

  return (
    <main id="main" class="page is-alone">
      <BrandMark alt="" />
      <h1>Sign in to Elflodge</h1>
      <form class="fields" onSubmit={signIn}>
        <div class="field">
          <label for="sign-in-email">Email</label>
          <input id="sign-in-email" name="email" type="email" autocomplete="username" required />
        </div>
        <div class="field">
          <label for="sign-in-password">Password</label>
          <input
            id="sign-in-password"
            name="password"
            type="password"
            autocomplete="current-password"
            required
          />
        </div>
        <Show when={error()}>{(message) => <Notice role="alert">{message()}</Notice>}</Show>
        <button type="submit" class="primary" disabled={pending()}>
          Sign in
        </button>
      </form>
    </main>
  );
}
