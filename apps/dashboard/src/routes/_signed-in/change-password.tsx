import { createFileRoute } from "@tanstack/solid-router";
import { Show, createSignal } from "solid-js";

import { attemptAuth, authClient } from "../../auth-client.ts";
import { fieldText } from "../../form.ts";

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
      <h1>Change password</h1>
      <form onSubmit={changePassword}>
        <label>
          Current password
          <input name="current-password" type="password" autocomplete="current-password" required />
        </label>
        <label>
          New password
          <input name="new-password" type="password" autocomplete="new-password" required />
        </label>
        <label>
          Confirm new password
          <input name="confirm-password" type="password" autocomplete="new-password" required />
        </label>
        <label class="choice">
          {/* Checked by default: a changed password may mean the old one leaked, and the other
              sessions were signed in with it. */}
          <input name="revoke-other-sessions" type="checkbox" checked />
          Sign out of other sessions
        </label>
        <Show when={result()}>{(shown) => <p role={shown().role}>{shown().message}</p>}</Show>
        <button type="submit" disabled={pending()}>
          Change password
        </button>
      </form>
    </>
  );
}
