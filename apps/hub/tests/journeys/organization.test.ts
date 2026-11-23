import type { Browser } from "playwright";
import { afterAll, beforeAll, expect, onTestFinished, test } from "vite-plus/test";

import { launchDashboardBrowser, newMember, signInAt } from "../dashboard-browser.ts";
import { startSystem } from "../harness.ts";

// What the hub takes from the Organization page: a member who leaves is no longer one.

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

test("a member can leave the Organization and immediately sees their remaining account access", async () => {
  const member = await newMember(system, "Leaving Tomas");
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  await signInAt(system, page, "organization", member);
  await page.getByRole("button", { name: "Leave Organization" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Leave Organization" }).click();
  await page.getByRole("heading", { name: "Organization access" }).waitFor();
  const [organization] = await system.ownerAuth().organization.list();
  if (!organization) throw new Error("The hub has no Organization");
  const { members } = await system
    .ownerAuth()
    .organization.listMembers({ query: { organizationId: organization.id } });
  expect(members.map(({ user }) => user.email)).not.toContain(member.email);
});
