import { createFileRoute } from "@tanstack/solid-router";
import { Show, createSignal } from "solid-js";

import { attemptAuth, authClient } from "../../auth-client.ts";
import { Notice } from "../../components/Notice.tsx";
import { NEW_PASSWORD, fieldText } from "../../form.ts";

export const Route = createFileRoute("/_signed-in/change-password")({
  component: ChangePassword,
});

function ChangePassword() {
  const [result, setResult] = createSignal<{ role: "alert" | "status"; message: string }>();
  const [pending, setPending] = createSignal(false);

  async function changePassword(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
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
    if (failure) {
      setResult({ role: "alert", message: failure });
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
          />
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
          {/* The same lengths as the new password: a field cuts what is pasted beyond its longest,
              and the two would then differ. */}
          <input
            id="confirm-password"
            name="confirm-password"
            type="password"
            autocomplete="new-password"
            required
            {...NEW_PASSWORD}
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
