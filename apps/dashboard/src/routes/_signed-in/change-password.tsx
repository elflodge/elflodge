import { BetterFetchError } from "@better-fetch/fetch";
import { createFileRoute } from "@tanstack/solid-router";
import { Show, createSignal, flush } from "solid-js";

import { hubFailureMessage } from "../../api-client.ts";
import { authClient } from "../../auth-client.ts";
import { FieldError } from "../../components/FieldError.tsx";
import { Notice } from "../../components/Notice.tsx";
import { NEW_PASSWORD, createFormAction, fieldText } from "../../form.ts";

export const Route = createFileRoute("/_signed-in/change-password")({
  component: ChangePassword,
});

/**
 * Better Auth's code for a current password that is wrong. Checked against its client's types:
 * `authClient.$ERROR_CODES`, where its documentation reads the codes, has them only in its types
 * in this version of its framework-neutral client.
 */
const INVALID_PASSWORD = "INVALID_PASSWORD" satisfies keyof typeof authClient.$ERROR_CODES;

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
      if (failure instanceof BetterFetchError && failure.error?.code === INVALID_PASSWORD) {
        // A refusal belongs to the submitted value. Leave a correction made meanwhile alone.
        if (currentPassword?.value !== submittedPassword) return;
        setResult(undefined);
        setCurrentRefused(true);
        // Apply its description before focusing the field so a screen reader announces it.
        flush();
        currentPassword.focus();
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
        <div class="field">
          <label for="current-password">Current password</label>
          <input
            id="current-password"
            name="current-password"
            type="password"
            autocomplete="current-password"
            required
            aria-invalid={currentRefused() ? "true" : undefined}
            aria-describedby={currentRefused() ? "current-password-error" : undefined}
            onInput={() => setCurrentRefused(false)}
            ref={(element) => {
              currentPassword = element;
            }}
          />
          <Show when={currentRefused()}>
            <FieldError id="current-password-error">{WRONG_CURRENT_PASSWORD}</FieldError>
          </Show>
        </div>
        <div class="field">
          <label for="new-password">New password</label>
          <input
            id="new-password"
            name="new-password"
            type="password"
            autocomplete="new-password"
            required
            {...NEW_PASSWORD}
          />
        </div>
        <div class="field">
          <label for="confirm-password">Confirm new password</label>
          <input
            id="confirm-password"
            name="confirm-password"
            type="password"
            autocomplete="new-password"
            required
          />
        </div>
        <label class="check">
          {/* Checked by default: a changed password may mean the old one leaked, and the other
              sessions were signed in with it. */}
          <input name="revoke-other-sessions" type="checkbox" checked />
          Sign out of other sessions
        </label>
        <Show when={result()}>
          {(shown) => <Notice role={shown().role}>{shown().message}</Notice>}
        </Show>
        <button type="submit" class="primary" disabled={pending()}>
          Change password
        </button>
      </form>
    </>
  );
}
