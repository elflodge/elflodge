import type { Browser } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterAll, beforeAll, expect, onTestFinished, test } from "vite-plus/test";

import { launchDashboardBrowser } from "./dashboard-browser.ts";
import { OWNER, startSystem } from "./harness.ts";

const system = startSystem();
let browser: Browser;
let organizationId: string;

beforeAll(async () => {
  await system.start();
  browser = await launchDashboardBrowser(system);
  const [organization] = await system.ownerAuth().organization.list();
  if (!organization) throw new Error("The hub has no Organization");
  organizationId = organization.id;
});
afterAll(async () => {
  await browser?.close();
  await system.stop();
});

async function openOrganization(credentials = OWNER) {
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  await page.goto(`${system.origin}/dashboard/organization`);
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: "Members", exact: true }).waitFor();
  return page;
}

async function addAdmin(name: string, email: string) {
  const person = await system.addMember({ name, email });
  const organization = system.ownerAuth().organization;
  const { members } = await organization.listMembers({ query: { organizationId } });
  const member = members.find((item) => item.userId === person.userId);
  if (!member) throw new Error("The new member is missing");
  await organization.updateMemberRole({ organizationId, memberId: member.id, role: "admin" });
  return person;
}

test("an owner can copy a link that lets its recipient join with the chosen role", async () => {
  const page = await openOrganization();
  const email = "lucia@example.com";
  await page.getByRole("button", { name: "Invite a member" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByRole("radio", { name: /^Admin/ }).check();
  await dialog.getByRole("button", { name: "Create invitation" }).click();
  const copy = dialog.getByRole("button", { name: "Copy the link" });
  await expectBrowser(copy).toBeFocused();
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], { origin: system.origin });
  await copy.click();
  const link = new URL(await page.evaluate<string>("navigator.clipboard.readText()"));
  expect(link.origin + link.pathname).toBe(system.origin + "/dashboard/invitation");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expectBrowser(page.getByRole("button", { name: `Copy link for ${email}` })).toBeVisible();
  const invitationId = link.hash.slice(1);
  expect(await system.client().invitations.preview({ invitationId })).toMatchObject({
    email,
    role: "admin",
  });
  await system
    .client()
    .invitations.accept({ invitationId, name: "Lucia", password: "an invited person's password" });
}, 30_000);

test("removing a member counts their active keys and invitations and keeps their keys identifiable", async () => {
  const admin = await addAdmin("Mei Tanaka", "mei@example.com");
  await admin.client.apiKeys.create({ name: "Importer", permissions: { job: ["read"] } });
  await system
    .authClient(admin.cookie)
    .organization.inviteMember({ organizationId, email: "teo@example.com", role: "member" });
  const page = await openOrganization();
  await page.getByRole("button", { name: "Remove Mei Tanaka" }).click();
  const dialog = page.getByRole("dialog");
  await expectBrowser(dialog).toContainText(
    "1 active API key created by Mei Tanaka keeps working. Review it under API keys, and the Runners registered with it under Runners.",
  );
  await expectBrowser(dialog).toContainText("Their 1 pending invitation stops working.");
  await dialog.getByRole("button", { name: "Remove Mei Tanaka" }).click();
  await expectBrowser(
    page.getByRole("status").filter({ hasText: "Mei Tanaka is removed." }),
  ).toBeFocused();
  await page
    .getByRole("navigation", { name: "Destinations" })
    .getByRole("link", { name: "API keys" })
    .click();
  await expectBrowser(page.getByRole("row").filter({ hasText: "Importer" })).toContainText(
    "Mei Tanaka (no longer a member)",
  );
}, 30_000);

test("a member can leave the Organization and immediately sees their remaining account access", async () => {
  const person = {
    name: "Tomas",
    email: "tomas@example.com",
    password: "a member's own long password",
  };
  await system.addMember(person);
  const page = await openOrganization(person);
  await expectBrowser(page.getByRole("heading", { name: "Invitations" })).toHaveCount(0);
  await page.getByRole("button", { name: "Leave Organization" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Leave Organization" }).click();
  await expectBrowser(page.getByRole("heading", { name: "Organization access" })).toBeVisible();
}, 30_000);

test.each(["last-owner refusal", "server error"])(
  "a stale Leave reports a %s beside the refreshed list",
  async (response) => {
    const email =
      response === "server error" ? "second-owner-server@example.com" : "second-owner@example.com";
    const person = await system.addMember({ name: "Second Owner", email });
    const organization = system.ownerAuth().organization;
    const { members } = await organization.listMembers({ query: { organizationId } });
    const member = members.find((row) => row.userId === person.userId);
    if (!member) throw new Error("The new member is missing");
    await organization.updateMemberRole({ organizationId, memberId: member.id, role: "owner" });
    const page = await openOrganization();
    await page.getByRole("button", { name: "Leave Organization" }).click();
    await system.authClient(person.cookie).organization.leave({ organizationId });
    if (response === "server error") {
      // A same-instant change can reach the database check, which has no public last-owner code.
      await page.route("**/api/auth/organization/leave", (route) =>
        route.fulfill({
          status: 500,
          json: { message: "Internal Server Error" },
        }),
      );
    }
    await page.getByRole("dialog").getByRole("button", { name: "Leave Organization" }).click();
    const alert = page.getByRole("alert");
    await expectBrowser(alert).toContainText(
      response === "server error"
        ? "The hub could not do this: Internal Server Error. The members were read again; check them before trying again."
        : "You are now the only owner, so you cannot leave or change your own role.",
    );
    await expectBrowser(page.getByRole("button", { name: "Leave Organization" })).toHaveCount(0);
    await expectBrowser(page.getByRole("row").filter({ hasText: email })).toHaveCount(0);
  },
  30_000,
);

test("an admin changing their own role immediately loses the management controls", async () => {
  const email = "devon@example.com";
  await addAdmin("Devon", email);
  const page = await openOrganization({ email, password: "a member's own long password" });
  await page.getByRole("button", { name: "Change role for yourself" }).click();
  const dialog = page.getByRole("dialog");
  await expectBrowser(dialog.getByRole("radio", { name: /^Owner/ })).toHaveCount(0);
  await dialog.getByRole("radio", { name: /^Member/ }).check();
  await dialog.getByRole("button", { name: "Change role" }).click();
  await expectBrowser(
    page.getByRole("status").filter({ hasText: "You are now a member." }),
  ).toBeFocused();
  await expectBrowser(page.getByRole("heading", { name: "Invitations" })).toHaveCount(0);
  await expectBrowser(page.getByRole("button", { name: "Invite a member" })).toHaveCount(0);
  await expectBrowser(page.getByRole("button", { name: "Change role for yourself" })).toHaveCount(
    0,
  );
  await expectBrowser(
    page
      .getByRole("row")
      .filter({ hasText: email })
      .getByRole("cell", { name: "Member", exact: true }),
  ).toBeVisible();
}, 30_000);
