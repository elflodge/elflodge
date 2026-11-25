import { expect } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser/context";

import { DASHBOARD_BASE } from "../../../hub/src/dashboard.ts";
import { NO_JOBS_LISTED, signedIn } from "../records.ts";
import { focus, test } from "./dashboard.tsx";
import { acceptSignIn } from "./shell.ts";

// Signing in, in a file of its own, as it starts signed out.

test("sign-in allows keyboard retry, takes only one submit during navigation and discards an off-site redirect", async ({
  hub,
  open,
}) => {
  const owner = signedIn("owner");
  hub.session.answers(null);
  hub.setup.get.answers({ needed: false });
  hub.auth.signIn.email.refuses("UNAUTHORIZED", "INVALID_EMAIL_OR_PASSWORD");
  hub.jobs.list.answers(NO_JOBS_LISTED);
  // A destination on another site is discarded, so signing in opens the Jobs list.
  const page = await open("sign-in?redirect=//elsewhere.example/other");
  await page.getByLabelText("Email").fill(owner.user.email);
  const password = page.getByLabelText("Password");
  await password.fill("incorrect password");
  const submit = page.getByRole("button", { name: "Sign in" });
  await focus(submit);
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("alert")).toBeVisible();
  await expect.element(submit).toHaveFocus();

  // The hub accepts the password, and the destination's first read of the session is held.
  acceptSignIn(hub, owner);
  hub.session.answers(owner);
  const reads = hub.session.hold();
  await password.fill("a member's password");
  await submit.click();
  await reads.arrived;
  await expect.element(submit).toBeDisabled();
  await userEvent.keyboard("{Enter}");
  const form = await page.getByCSS("form").findElement();
  if (!(form instanceof HTMLFormElement)) throw new Error("The sign-in page has no form");
  form.requestSubmit();
  reads.release();
  await expect.element(page.getByRole("heading", { name: "Jobs", level: 1 })).toBeVisible();
  expect(location.pathname).toBe(`${DASHBOARD_BASE}jobs`);
  expect(hub.auth.signIn.email.calls).toEqual([
    { email: owner.user.email, password: "incorrect password" },
    { email: owner.user.email, password: "a member's password" },
  ]);
});
