import { createFileRoute } from "@tanstack/solid-router";
import { Show, createSignal, flush } from "solid-js";

import { attemptAuth, authClient } from "../../auth-client.ts";
import { FieldError } from "../../components/FieldError.tsx";
import { Notice } from "../../components/Notice.tsx";
import { NEW_PASSWORD, fieldText } from "../../form.ts";

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
  const [pending, setPending] = createSignal(false);
  let currentPassword: HTMLInputElement | undefined;

  async function changePassword(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setCurrentRefused(false);
    const newPassword = fieldText(form, "new-password");
    if (newPassword !== fieldText(form, "confirm-password")) {
      setResult({ role: "alert", message: "The new password and its confirmation differ." });
      return;
    }
    const revokeOtherSessions = form.has("revoke-other-sessions");
    const failure = await attemptAuth(
      () =>
        authClient.changePassword({
          currentPassword: fieldText(form, "current-password"),
          newPassword,
          revokeOtherSessions,
        }),
      setPending,
    );
    // Better Auth answers a wrong current password with "Invalid password", which could mean any of
    // the three, so it is said at the field it is about, where the focus goes to correct it.
    if (failure?.code === INVALID_PASSWORD) {
      setResult(undefined);
      setCurrentRefused(true);
      // Solid applies writes in a batch after this handler; flush applies them now, so the field
      // has its error and description when the focus lands and a screen reader says them.
      flush();
      currentPassword?.focus();
      return;
    }
    if (failure) {
      setResult({ role: "alert", message: failure.message });
      return;
    }
    formElement.reset();
    setResult({
      role: "status",
      message: revokeOtherSessions
        ? "Your password is changed. Every other session signed in as you has ended."
        : "Your password is changed.",
    });
  }

  return (
    <>
      <div class="head">
        <h1>Change password</h1>
      </div>
      <form class="fields" onSubmit={changePassword}>
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
