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

test("an open page returns to sign-in when a background read finds its session ended elsewhere", async () => {
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  const member = await newMember(system, "Ended Elsewhere");
  await signInAt(system, page, "jobs", member);
  await page.getByRole("heading", { name: "Jobs", level: 1 }).waitFor();

  // The session ends at the hub, with no sign-out in this browser and no navigation.
  const cookie = (await page.context().cookies())
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  await system.authClient(cookie).signOut();

  // The hub strip's next poll of the counts, within five seconds, is refused, and the session read
  // that follows names no one.
  await expectBrowser(page.getByRole("heading", { name: "Sign in to Elflodge" })).toBeVisible({
    timeout: 10_000,
  });
  expect(new URL(page.url()).searchParams.get("redirect")).toContain("/jobs");
}, 30_000);

test("a member change in another tab of the browser loads a fresh document", async () => {
  const context = await browser.newContext();
  onTestFinished(() => context.close());
  const [first, next] = await Promise.all([
    newMember(system, "First Tab"),
    newMember(system, "Next Tab"),
  ]);
  const page = await context.newPage();
  await signInAt(system, page, "change-password", first);
  await page.getByRole("button", { name: first.name, exact: true }).waitFor();
  const firstDocument = await page.evaluate(() => performance.timeOrigin);
  const other = await context.newPage();
  await other.goto(`${system.origin}/dashboard/jobs`);
  const otherAccount = other.getByRole("button", { name: first.name, exact: true });

  // Signed out in the other tab, this one, at its next session read, loads the sign-in page anew.
  await otherAccount.click();
  await other.getByRole("button", { name: "Sign out" }).click();
  await other.waitForURL(/\/sign-in/);
  await expectBrowser(page.getByRole("heading", { name: "Sign in to Elflodge" })).toBeVisible({
    timeout: 10_000,
  });
  const signInDocument = await page.evaluate(() => performance.timeOrigin);
  expect(signInDocument).not.toBe(firstDocument);

  // Signing in here keeps the document, which had shown no member.
  await page.getByLabel("Email").fill(first.email);
  await page.getByLabel("Password").fill(first.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${system.origin}/dashboard/change-password`);
  await page.getByRole("button", { name: first.name, exact: true }).waitFor();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(signInDocument);

  // Signed in as the next member in the other tab, over this one's session, this one shows the next
  // member at its next session read, when it opens another page.
  await other.getByLabel("Email").fill(next.email);
  await other.getByLabel("Password").fill(next.password);
  await other.getByRole("button", { name: "Sign in" }).click();
  await other.getByRole("button", { name: next.name, exact: true }).waitFor();
  await page
    .getByRole("navigation", { name: "Destinations" })
    .getByRole("link", { name: "Jobs" })
    .click();
  await expectBrowser(page.getByRole("button", { name: next.name, exact: true })).toBeVisible({
    timeout: 10_000,
  });
  expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(signInDocument);
  expect(new URL(page.url()).pathname).toBe("/dashboard/jobs");
}, 60_000);
