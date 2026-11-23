import { ORPCError } from "@orpc/client";
import { Link, createFileRoute, redirect, useLocation, useNavigate } from "@tanstack/solid-router";
import { Button } from "@ui-sdk/solid/button";
import { FieldControl } from "@ui-sdk/solid/field";
import { Input } from "@ui-sdk/solid/input";
import { Show, createSignal, onSettled } from "solid-js";

import { api, failureDetailSuffix, hubFailureDetail, readFromHub } from "../api-client.ts";
import { authClient } from "../auth-client.ts";
import { BrandMark } from "../components/BrandMark.tsx";
import { Field } from "../components/Field.tsx";
import { Notice } from "../components/Notice.tsx";
import {
  GIVEN_NAME,
  NEW_PASSWORD,
  createFormAction,
  fieldText,
  focusIfLost,
  formRefusal,
} from "../form.ts";
import { pageHead } from "../page-title.ts";

// Setting up a new hub: creating its owner with the setup link the hub printed (ADR 0015). The
// link's token comes after `#`, so it never reaches the hub's request logs.
export const Route = createFileRoute("/setup")({
  head: () => pageHead("Set up"),
  loader: async () => {
    const { needed } = await readFromHub("Whether the hub is set up", () => api.setup.get());
    if (!needed) throw redirect({ to: "/sign-in" });
  },
  component: Setup,
});

function Setup() {
  const navigate = useNavigate();
  // Read from the router, so a link opened over this page, which changes only its hash, counts.
  const token = useLocation({ select: (location) => location.hash });
  const [error, setError] = createSignal<string>();
  const [fields, setFields] = createSignal<Map<string, string>>();
  const field = (name: string) => fields()?.get(name);
  const [alreadySetUp, setAlreadySetUp] = createSignal(false);
  const { pending, onSubmit } = createFormAction(async (element) => {
    setError(undefined);
    setFields(undefined);
    const form = new FormData(element);
    const organizationName = fieldText(form, "organizationName");
    const owner = { email: fieldText(form, "email"), password: fieldText(form, "password") };
    const name = fieldText(form, "name");
    try {
      await api.setup.complete({ token: token(), organizationName, name, ...owner });
    } catch (failure) {
      if (failure instanceof ORPCError && failure.code === "CONFLICT") setAlreadySetUp(true);
      else {
        const refusal = formRefusal(failure, {
          organizationName: ["organizationName"],
          name: ["name"],
          email: ["email"],
          password: ["password"],
        });
        setError(refusal.alert);
        setFields(refusal.fields);
      }
      return;
    }
    try {
      await authClient.signIn.email(owner);
    } catch (failure) {
      // The owner exists, so the form is done with. The sign-in page can try again.
      setError(
        `The owner was created, but signing in failed${failureDetailSuffix(hubFailureDetail(failure))}`,
      );
      setAlreadySetUp(true);
      return;
    }
    await navigate({ to: "/" });
  });

  return (
    <main id="main" class="page is-alone">
      <BrandMark alt="" />
      <h1>Set up Elflodge</h1>
      <Show
        when={!alreadySetUp()}
        fallback={
          <>
            <Show when={error()} keyed>
              {(message) => <Notice role="alert">{message}</Notice>}
            </Show>
            <p class="prose">
              This hub is set up.{" "}
              <Link
                to="/sign-in"
                ref={(link) =>
                  onSettled(() => {
                    // The completed form and its focused control have been replaced by this link.
                    focusIfLost(link);
                  })
                }
              >
                Sign in
              </Link>
            </p>
          </>
        }
      >
        <Show
          when={token()}
          fallback={
            <p class="prose">
              Open the setup link the hub printed when it started; it works for an hour. For a hub
              in Docker, <code>docker compose logs hub</code> shows it and{" "}
              <code>docker compose restart hub</code> prints a new one; for a hub on Workers,{" "}
              <code>vp run setup</code> prints one.
            </p>
          }
        >
          <p class="prose">
            Create the hub's owner, who manages its members, API keys and Runners.
          </p>
          <form
            class="fields"
            onSubmit={onSubmit}
            onInput={({ target }) => {
              if (target instanceof HTMLInputElement && fields()?.has(target.name)) {
                const remaining = new Map(fields());
                remaining.delete(target.name);
                setFields(remaining);
              }
            }}
          >
            <Field label="Organization name" error={field("organizationName")}>
              <Input name="organizationName" autocomplete="organization" required {...GIVEN_NAME} />
            </Field>
            <Field label="Your name" error={field("name")}>
              <Input name="name" autocomplete="name" required {...GIVEN_NAME} />
            </Field>
            <Field label="Email" error={field("email")}>
              <Input name="email" type="email" autocomplete="username" required />
            </Field>
            <Field label="Password" error={field("password")}>
              <FieldControl
                name="password"
                type="password"
                autocomplete="new-password"
                required
                {...NEW_PASSWORD}
              />
            </Field>
            <Show when={error()} keyed>
              {(message) => <Notice role="alert">{message}</Notice>}
            </Show>
            <Button type="submit" class="primary" disabled={pending()} focusableWhenDisabled>
              Create owner
            </Button>
          </form>
        </Show>
      </Show>
    </main>
  );
}
