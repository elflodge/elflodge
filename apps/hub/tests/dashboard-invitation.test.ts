import type { Browser } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterAll, beforeAll, expect, onTestFinished, test } from "vite-plus/test";

import { launchDashboardBrowser } from "./dashboard-browser.ts";
import { startSystem } from "./harness.ts";

const system = startSystem();
let browser: Browser;
let organizationId: string;

beforeAll(async () => {
  await system.start();
  const [organization] = await system.ownerAuth().organization.list();
  if (!organization) throw new Error("The hub has no Organization");
  organizationId = organization.id;
  browser = await launchDashboardBrowser(system);
});
afterAll(async () => {
  await browser?.close();
  await system.stop();
});

async function invite(email: string) {
  const { id } = await system
    .ownerAuth()
    .organization.inviteMember({ email, organizationId, role: "member" });
  return new URL(`/dashboard/invitation#${id}`, system.origin);
}

test("a new invitee creates an account and lands signed in as a member", async () => {
  const email = "lucia@example.com";
  const link = await invite(email);
  const page = await browser.newPage();
  onTestFinished(() => page.close());

  await page.goto(link.href);
  await expectBrowser(page.getByLabel("Email")).toHaveValue(email);
  await page.getByLabel("Your name").fill("Lucia");
  await page.getByLabel("Password").fill("a long enough password");
  await page.getByRole("button", { name: "Create account and join" }).click();

  await expectBrowser(page).toHaveURL(system.origin + "/dashboard/");
  await expectBrowser(page.getByRole("heading", { name: "Connected to your hub" })).toBeVisible();
  await expectBrowser(page.getByRole("button", { name: "Lucia" })).toBeVisible();
}, 30_000);

test("a returning invitee can sign in through a private link and choose when to rejoin", async () => {
  const email = "returning@example.com";
  const password = "a returning member's password";
  await system.addMember({ email, name: "Returning member", password });
  await system.ownerAuth().organization.removeMember({ memberIdOrEmail: email, organizationId });
  const link = await invite(email);
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  // A reload on the sign-in page must keep the invitation out of request URLs and referrers.
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url(), request.headers().referer ?? ""));

  await page.goto(link.href);
  await page.getByLabel("Your name").fill("Returning member");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account and join" }).click();
  const signIn = page.getByRole("link", { name: "Sign in", exact: true });
  await expectBrowser(signIn).toBeFocused();
  await signIn.click();
  await page.getByRole("heading", { name: "Sign in to Elflodge" }).waitFor();
  await page.reload();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expectBrowser(page).toHaveURL(link.href);
  await page.getByRole("button", { name: "Join Organization" }).click();
  await expectBrowser(page.getByRole("heading", { name: "Connected to your hub" })).toBeVisible();
  expect(requests.map((url) => url.split("#")[0]).join("\n")).not.toContain(link.hash.slice(1));
}, 30_000);
