import { createFileRoute, redirect, useRouter } from "@tanstack/solid-router";
import { Button } from "@ui-sdk/solid/button";
import { FieldControl } from "@ui-sdk/solid/field";
import { Input } from "@ui-sdk/solid/input";
import { Show, createSignal } from "solid-js";
import * as z from "zod/mini";

import { api, hubFailureMessage, readFromHub } from "../api-client.ts";
import { authClient } from "../auth-client.ts";
import { BrandMark } from "../components/BrandMark.tsx";
import { Field } from "../components/Field.tsx";
import { Notice } from "../components/Notice.tsx";
import { createFormAction, fieldText } from "../form.ts";
import { pageHead } from "../page-title.ts";

export const Route = createFileRoute("/sign-in")({
  head: () => pageHead("Sign in"),
  validateSearch: z.object({
    redirect: z.catch(
      z.optional(
        z.pipe(
          z.string().check(z.startsWith("/")),
          z.transform((target) => {
            const origin = location.origin;
            if (!URL.canParse(target, origin)) return undefined;
            const url = new URL(target, origin);
            // The router takes a path. Removing the origin must still leave a path on this hub.
            if (url.origin !== origin || url.pathname.startsWith("//")) return undefined;
            return url.pathname + url.search + url.hash;
          }),
        ),
      ),
      undefined,
    ),
  }),
  // A hub without an owner has no one to sign in; setting it up comes first.
  loader: async () => {
    const { needed } = await readFromHub("Whether the hub is set up", () => api.setup.get());
    if (needed) throw redirect({ to: "/setup" });
  },
  component: SignIn,
});

function SignIn() {
  const search = Route.useSearch();
  const router = useRouter();
  const [error, setError] = createSignal<string>();
  const { pending, onSubmit } = createFormAction(async (element) => {
    const form = new FormData(element);
    try {
      await authClient.signIn.email({
        email: fieldText(form, "email"),
        password: fieldText(form, "password"),
      });
    } catch (failure) {
      setError(hubFailureMessage(failure));
      return;
    }
    const target = search().redirect;
    if (!target) {
      await router.navigate({ to: "/" });
      return;
    }
    // A return address can have its own query and fragment. Otherwise keep the fragment the
    // sign-in link carried separately, outside the HTTP request.
    const destination = router.parseLocation(
      Object.assign(new URL(target, location.origin), { state: router.history.location.state }),
    );
    await router.navigate({
      to: destination.pathname,
      search: destination.search,
      hash: destination.hash || true,
    });
  });

  return (
    <main id="main" class="page is-alone">
      <BrandMark alt="" />
      <h1>Sign in to Elflodge</h1>
      <form class="fields" onSubmit={onSubmit}>
        <Field label="Email">
          <Input name="email" type="email" autocomplete="username" required />
        </Field>
        <Field label="Password">
          <FieldControl name="password" type="password" autocomplete="current-password" required />
        </Field>
        <Show when={error()} keyed>
          {(message) => <Notice role="alert">{message}</Notice>}
        </Show>
        <Button type="submit" class="primary" disabled={pending()} focusableWhenDisabled>
          Sign in
        </Button>
      </form>
    </main>
  );
}
