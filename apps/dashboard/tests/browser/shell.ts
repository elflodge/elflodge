import type { BrowserPage } from "vite-plus/test/browser/context";

import type { Hub, Session } from "../hub.ts";

// The shell's sign-in, for its tests, whose files start signed out: the app reloads a document
// once no one follows the first member it showed (member-document.ts), and Vitest gives each file a
// document of its own.

/** Arranges a hub whose sign-in accepts `session`'s member. */
export function acceptSignIn(hub: Hub, session: NonNullable<Session>) {
  hub.setup.get.answers({ needed: false });
  hub.auth.signIn.email.answers({
    redirect: false,
    token: session.session.token,
    user: session.user,
  });
}

/** Signs in on the sign-in page `page` shows, as the member `session` names. */
export async function signIn(page: BrowserPage, session: NonNullable<Session>) {
  await page.getByLabelText("Email").fill(session.user.email);
  await page.getByLabelText("Password").fill("a member's password");
  await page.getByRole("button", { name: "Sign in" }).click();
}
