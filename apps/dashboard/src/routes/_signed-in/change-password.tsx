import { createFileRoute } from "@tanstack/solid-router";
import { Button } from "@ui-sdk/solid/button";
import { FieldControl } from "@ui-sdk/solid/field";
import { Show, createSignal } from "solid-js";

import { hubFailureMessage } from "../../api-client.ts";
import { authClient, hasAuthCode } from "../../auth-client.ts";
import { Field } from "../../components/Field.tsx";
import { Notice } from "../../components/Notice.tsx";
import { NEW_PASSWORD, createFormAction, fieldText } from "../../form.ts";
import { pageHead } from "../../page-title.ts";

export const Route = createFileRoute("/_signed-in/change-password")({
  head: () => pageHead("Change password"),
  component: ChangePassword,
});

/** What the member reads at the current password's field when the hub refuses it. */
const WRONG_CURRENT_PASSWORD = "That is not your current password.";

function ChangePassword() {
  const [result, setResult] = createSignal<{ role: "alert" | "status"; message: string }>();
  const [currentRefused, setCurrentRefused] = createSignal(false);
  let currentPassword: HTMLInputElement | undefined;

  const { pending, onSubmit } = createFormAction(async (formElement) => {
    const form = new FormData(formElement);
    setCurrentRefused(false);
    const newPassword = fieldText(form, "new-password");
    if (newPassword !== fieldText(form, "confirm-password")) {
      setResult({ role: "alert", message: "The new password and its confirmation differ." });
      return;
    }
    const submittedPassword = fieldText(form, "current-password");
    const revokeOtherSessions = form.has("revoke-other-sessions");
    try {
      await authClient.changePassword({
        currentPassword: submittedPassword,
        newPassword,
        revokeOtherSessions,
      });
    } catch (failure) {
      // Better Auth's "Invalid password" could mean any of the three. Say which field to correct.
      if (hasAuthCode(failure, "INVALID_PASSWORD")) {
        // A refusal belongs to the submitted value. Leave a correction made meanwhile alone.
        if (currentPassword?.value !== submittedPassword) return;
        setResult(undefined);
        setCurrentRefused(true);
      } else {
        setResult({ role: "alert", message: hubFailureMessage(failure) });
      }
      return;
    }
    formElement.reset();
    setResult({
      role: "status",
      message: revokeOtherSessions
        ? "Your password is changed. Every other session signed in as you has ended."
        : "Your password is changed.",
    });
  });

  return (
    <>
      <div class="head">
        <h1>Change password</h1>
      </div>
      <form class="fields" onSubmit={onSubmit}>
        <Field
          label="Current password"
          error={currentRefused() ? WRONG_CURRENT_PASSWORD : undefined}
        >
          <FieldControl
            name="current-password"
            type="password"
            autocomplete="current-password"
            required
            onInput={() => setCurrentRefused(false)}
            ref={(element) => {
              currentPassword = element;
            }}
          />
        </Field>
        <Field label="New password">
          <FieldControl
            name="new-password"
            type="password"
            autocomplete="new-password"
            required
            {...NEW_PASSWORD}
          />
        </Field>
        <Field label="Confirm new password">
          <FieldControl
            name="confirm-password"
            type="password"
            autocomplete="new-password"
            required
          />
        </Field>
        <label class="check">
          {/* Checked by default: a changed password may mean the old one leaked, and the other
              sessions were signed in with it. */}
          <input name="revoke-other-sessions" type="checkbox" checked />
          Sign out of other sessions
        </label>
        <Show when={result()}>
          <Notice role={result()?.role ?? "status"}>{result()?.message}</Notice>
        </Show>
        <Button type="submit" class="primary" disabled={pending()} focusableWhenDisabled>
          Change password
        </Button>
      </form>
    </>
  );
}
