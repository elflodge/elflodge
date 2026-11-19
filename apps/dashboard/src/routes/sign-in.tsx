import { createFileRoute, redirect, useNavigate } from "@tanstack/solid-router";
import ensureError from "ensure-error";
import { Show, createSignal } from "solid-js";
import * as z from "zod/mini";

import { api, apiFailureMessage, readApi } from "../api-client.ts";
import { authClient } from "../auth-client.ts";
import { BrandMark } from "../components/BrandMark.tsx";
import { Notice } from "../components/Notice.tsx";
import { createFormAction, fieldText } from "../form.ts";

export const Route = createFileRoute("/sign-in")({
  validateSearch: z.object({
    // The router resolves a single leading slash inside the dashboard. URL parsers normalize
    // backslashes and control characters, so neither belongs in a redirect path.
    redirect: z.catch(z.optional(z.string().check(z.regex(/^\/(?!\/)[^\\\p{Cc}]*$/u))), undefined),
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
  const { pending, onSubmit } = createFormAction(async (element) => {
    const form = new FormData(element);
    try {
      await authClient.signIn.email({
        email: fieldText(form, "email"),
        password: fieldText(form, "password"),
      });
    } catch (failure) {
      setError(apiFailureMessage(ensureError(failure)));
      return;
    }
    const target = search().redirect;
    await (target === undefined ? navigate({ to: "/" }) : navigate({ href: target }));
  });

  return (
    <main id="main" class="page is-alone">
      <BrandMark alt="" />
      <h1>Sign in to Elflodge</h1>
      <form class="fields" onSubmit={onSubmit}>
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
