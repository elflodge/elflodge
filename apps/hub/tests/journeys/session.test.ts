import type { Browser } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterAll, beforeAll, expect, onTestFinished, test } from "vite-plus/test";

import { launchDashboardBrowser, newMember, signInAt } from "../dashboard-browser.ts";
import { startSystem } from "../harness.ts";

// A member's session through Better Auth, as a browser keeps it across a reload, a password change
// and signing out.

const system = startSystem();
let browser: Browser;

beforeAll(async () => {
  await system.start();
  browser = await launchDashboardBrowser(system);
});
afterAll(async () => {
  await browser?.close();
  await system.stop();
});

test("in a browser, a member signs in, reloads a page, changes the password and signs out", async () => {
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  const dashboard = `${system.origin}/dashboard`;

  // Signed out, a page sends the member to sign in, and back to it once signed in.
  const member = await newMember(system, "Password Reader");
  await signInAt(system, page, "change-password", member);
  // The bar names who is signed in; their name opens the account menu.
  const account = page.getByRole("button", { name: member.name, exact: true });
  await account.waitFor();

  await page.reload();
  const heading = page.getByRole("heading", { name: "Change password" });
  await heading.waitFor();

  // A wrong current password is refused at its field, not with words that could mean any of three.
  const password = "a new password for this member";
  const current = page.getByLabel("Current password");
  await current.fill("incorrect password");
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm new password").fill(password);
  await page.getByRole("button", { name: "Change password" }).click();
  await expectBrowser(current).toHaveAttribute("aria-invalid", "true");
  await expectBrowser(current).toHaveAccessibleDescription("That is not your current password.");
  await expectBrowser(current).toBeFocused();

  await current.fill(member.password);
  // The change makes a new session for the same member, which the page reads; it stays, and so does
  // what it said.
  const signedInDocument = await page.evaluate(() => performance.timeOrigin);
  const sessionRead = page.waitForResponse(
    (response) =>
      response.url().includes("/api/auth/get-session") && response.request().method() === "GET",
  );
  await page.getByRole("button", { name: "Change password" }).click();
  await page.getByRole("status").waitFor();
  await sessionRead;
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(signedInDocument);
  await expectBrowser(page.getByRole("status")).toHaveText(/^Your password is changed/);

  await account.click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(`${dashboard}/sign-in`);
  await page.getByRole("heading", { name: "Sign in to Elflodge" }).waitFor();
  expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(signedInDocument);
  // The new password signs in.
  await system.signIn({ email: member.email, password });
}, 30_000);
