import type { Browser, Page } from "playwright";
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

const PASSWORD = "a member's own long password";

async function openOrganization(credentials = OWNER, { clock = false } = {}) {
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  if (clock) await page.clock.install();
  await page.goto(`${system.origin}/dashboard/organization`);
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: "Members", exact: true }).waitFor();
  return page;
}

/** The membership of the account `userId`, as the owner reads it. */
async function membershipOf(userId: string) {
  const { members } = await system
    .ownerAuth()
    .organization.listMembers({ query: { organizationId } });
  const member = members.find((item) => item.userId === userId);
  if (!member) throw new Error("The member is missing");
  return member;
}

async function setRole(
  userId: string,
  role: "owner" | "admin" | "member",
  auth = system.ownerAuth(),
) {
  const { id } = await membershipOf(userId);
  await auth.organization.updateMemberRole({ organizationId, memberId: id, role });
}

async function addAdmin(name: string, email: string) {
  const person = await system.addMember({ name, email });
  await setRole(person.userId, "admin");
  return person;
}

/** A read of the members the page makes from now on, and its release. */
function holdMemberReads(page: Page) {
  return holdReads(page, (url) => url.pathname === "/api/auth/organization/list-members");
}

/** Holds every request matching `url` from `start()` on, until `release()`. */
async function holdReads(page: Page, url: (url: URL) => boolean) {
  let holding = false;
  const arrived = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  onTestFinished(() => released.resolve());
  await page.route(url, async (route) => {
    if (holding) {
      arrived.resolve();
      await released.promise;
    }
    await route.continue();
  });
  return {
    start: () => {
      holding = true;
    },
    arrived: arrived.promise,
    release: () => released.resolve(),
  };
}

/** Has the page read its lists again, as returning to a stale tab does. */
async function readAgain(page: Page) {
  await page.clock.setFixedTime(new Date(Date.now() + 10_000));
  await page.evaluate('window.dispatchEvent(new Event("visibilitychange"))');
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

test("the email field explains why an admin cannot replace an owner invitation", async () => {
  const email = "mara@example.com";
  const invitation = await system.ownerAuth().organization.inviteMember({
    organizationId,
    email,
    role: "owner",
  });
  const adminEmail = "sam@example.com";
  await addAdmin("Sam", adminEmail);
  const page = await openOrganization({
    email: adminEmail,
    password: "a member's own long password",
  });
  await page.getByRole("button", { name: "Invite a member" }).click();
  const dialog = page.getByRole("dialog");
  const field = dialog.getByLabel("Email");
  await field.fill(email);
  await dialog.getByRole("radio", { name: /^Member/ }).check();
  await dialog.getByRole("button", { name: "Create invitation" }).click();
  await expectBrowser(field).toHaveAccessibleDescription(
    "This address has an invitation only an owner can replace.",
  );
  await expectBrowser(field).toHaveAttribute("aria-invalid", "true");
  await expectBrowser(field).toHaveValue(email);
  await expectBrowser(field).toBeFocused();
  expect(await system.owner().invitations.list()).toContainEqual(
    expect.objectContaining({ id: invitation.id, email, role: "owner" }),
  );
}, 30_000);

test("an invite refusal keeps focus on Close when the member moved there", async () => {
  const page = await openOrganization();
  await page.getByRole("button", { name: "Invite a member" }).click();
  const dialog = page.getByRole("dialog");
  const email = dialog.getByLabel("Email");
  await email.fill(OWNER.email);
  const release = Promise.withResolvers<void>();
  await page.route("**/api/auth/organization/invite-member", async (route) => {
    await release.promise;
    await route.continue();
  });
  await dialog.getByRole("button", { name: "Create invitation" }).click();
  try {
    await dialog.getByRole("button", { name: "Close" }).focus();
  } finally {
    release.resolve();
  }
  await expectBrowser(email).toHaveAccessibleDescription("This address is already a member.");
  // The same button reads Close while pending and Cancel once the hub answers.
  await expectBrowser(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
}, 30_000);

test("removing a member counts their active keys and invitations and keeps their keys identifiable", async () => {
  const admin = await addAdmin("Mei Tanaka", "mei@example.com");
  await admin.client.apiKeys.create({ name: "Importer", permissions: { job: ["read"] } });
  await system
    .authClient(admin.cookie)
    .organization.inviteMember({ organizationId, email: "teo@example.com", role: "member" });
  const page = await openOrganization();
  const dialog = page.getByRole("dialog");
  await page.getByRole("button", { name: "Change role for Mei Tanaka" }).click();
  await dialog.getByRole("radio", { name: /^Member/ }).check();
  await expectBrowser(dialog).toContainText(
    "1 active API key created by Mei Tanaka keeps working.",
  );
  await expectBrowser(dialog).toContainText("Their 1 pending invitation stops working.");
  await dialog.getByRole("radio", { name: /^Admin/ }).check();
  await expectBrowser(dialog).not.toContainText("pending invitation");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Remove Mei Tanaka" }).click();
  const confirmation = page.getByRole("alertdialog");
  await expectBrowser(confirmation).toContainText(
    "1 active API key created by Mei Tanaka keeps working. Review it under API keys, and the Runners registered with it under Runners.",
  );
  await expectBrowser(confirmation).toContainText("Their 1 pending invitation stops working.");
  await confirmation.getByRole("button", { name: "Remove Mei Tanaka" }).click();
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
  await page.getByRole("alertdialog").getByRole("button", { name: "Leave Organization" }).click();
  await expectBrowser(page.getByRole("heading", { name: "Organization access" })).toBeFocused();
  await expectBrowser(page).toHaveTitle("Organization access · Elflodge");
}, 30_000);

test("a Leave that fails without a refusal says it may have been done", async () => {
  const email = "second-owner-server@example.com";
  const person = await system.addMember({ name: "Second Owner", email });
  await setRole(person.userId, "owner");
  onTestFinished(async () => {
    await system.authClient(person.cookie).organization.leave({ organizationId });
  });
  const page = await openOrganization();
  await page.getByRole("button", { name: "Leave Organization" }).click();
  const dialog = page.getByRole("alertdialog");
  const answer = Promise.withResolvers<void>();
  onTestFinished(() => answer.resolve());
  await page.route("**/api/auth/organization/leave", async (route) => {
    await answer.promise;
    await route.fulfill({ status: 500, json: { message: "Internal Server Error" } });
  });
  await dialog.getByRole("button", { name: "Leave Organization" }).click();
  await expectBrowser(dialog.getByText("Working…")).toBeVisible();
  answer.resolve();
  await expectBrowser(dialog.getByRole("alert")).toHaveText(
    "The dashboard could not confirm this was done. Check before trying again.",
  );
  await expectBrowser(dialog.getByText("Working…")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Stay" }).click();
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(page.getByRole("button", { name: "Leave Organization" })).toBeFocused();
}, 30_000);

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

test("a role changed by another owner replaces the open draft before it can be submitted", async () => {
  const name = "Robin Soto";
  const person = await addAdmin(name, "robin@example.com");
  const org = system.ownerAuth().organization;
  const { members } = await org.listMembers({ query: { organizationId } });
  const member = members.find((row) => row.userId === person.userId);
  if (!member) throw new Error("The new admin is missing");
  const page = await openOrganization();
  await page.getByRole("button", { name: `Change role for ${name}` }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: /^Member/ }).check();
  await org.updateMemberRole({ organizationId, memberId: member.id, role: "owner" });
  await page.clock.setFixedTime(new Date(Date.now() + 10_000));
  // Returning to a stale tab reads the table again without closing the editor.
  await page.evaluate('window.dispatchEvent(new Event("visibilitychange"))');
  await expectBrowser(dialog.getByRole("radio", { name: /^Owner/ })).toBeChecked();
  let writes = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/auth/organization/update-member-role") writes++;
  });
  await dialog.getByRole("button", { name: "Change role" }).click();
  await expectBrowser(dialog).toHaveCount(0);
  expect(writes).toBe(0);
}, 30_000);

test("a failed keys read leaves members and invitations usable and explains the missing counts", async () => {
  const email = "piper@example.com";
  await addAdmin("Piper", email);
  const name = "River";
  await system.addMember({ name, email: "river@example.com" });
  const page = await openOrganization({ email, password: "a member's own long password" });
  await page.route(
    (url) => url.pathname === "/api-keys",
    (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/problem+json",
        json: {
          type: "about:blank",
          title: "Forbidden",
          status: 403,
          detail: "The keys could not be read.",
        },
      }),
  );
  await page.reload();
  await expectBrowser(page.getByRole("heading", { name: "Invitations" })).toBeVisible();
  await expectBrowser(page.getByRole("alert")).toContainText("The API keys could not be read");
  const dialog = page.getByRole("alertdialog");
  await page.getByRole("button", { name: `Remove ${name}` }).click();
  await expectBrowser(dialog.getByRole("alert")).toContainText("The API keys could not be read");
  await expectBrowser(dialog).toContainText(`API keys created by ${name} keep working.`);
  await dialog.getByRole("button", { name: "Keep them" }).click();
  await page.getByRole("button", { name: "Leave Organization" }).click();
  await expectBrowser(dialog.getByRole("alert")).toContainText("The API keys could not be read");
  await expectBrowser(dialog).toContainText("API keys you created keep working.");
  await dialog.getByRole("button", { name: "Stay" }).click();
  await page
    .getByRole("navigation", { name: "Destinations" })
    .getByRole("link", { name: "API keys" })
    .click();
  await expectBrowser(page.getByRole("heading", { name: "API keys" })).toBeVisible();
  await expectBrowser(page.getByRole("alert")).toContainText("The API keys could not be read");
}, 30_000);

test("a removed member's notice shows while the lists are read again, and another removal opens meanwhile", async () => {
  await system.addMember({ name: "Held Ana", email: "held-ana@example.com" });
  await system.addMember({ name: "Held Ben", email: "held-ben@example.com" });
  const page = await openOrganization();
  const reads = await Promise.all([
    holdMemberReads(page),
    holdReads(page, (url) => url.pathname === "/invitations"),
    holdReads(page, (url) => url.pathname === "/api-keys"),
  ]);
  await page.route("**/api/auth/organization/remove-member", async (route) => {
    for (const read of reads) read.start();
    await route.continue();
  });
  const dialog = page.getByRole("alertdialog");
  await page.getByRole("button", { name: "Remove Held Ana" }).click();
  await dialog.getByRole("button", { name: "Remove Held Ana" }).click();
  await expectBrowser(
    page.getByRole("status").filter({ hasText: "Held Ana is removed." }),
  ).toBeFocused();
  await Promise.all(reads.map((read) => read.arrived));
  await expectBrowser(
    page.getByRole("status").filter({ hasText: "Held Ana is removed." }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Remove Held Ben" }).click();
  await expectBrowser(dialog.getByRole("heading")).toHaveText("Remove Held Ben from Organization?");
  await expectBrowser(dialog.getByRole("button", { name: "Keep them" })).toBeFocused();
}, 30_000);

test("a stray Enter on a Remove keeps the member", async () => {
  await system.addMember({ name: "Kept Kai", email: "kept-kai@example.com" });
  const page = await openOrganization();
  let sent = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/auth/organization/remove-member") sent++;
  });
  const remove = page.getByRole("button", { name: "Remove Kept Kai" });
  await remove.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("alertdialog");
  await expectBrowser(dialog.getByRole("button", { name: "Keep them" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(remove).toBeFocused();
  expect(sent).toBe(0);
}, 30_000);

test("a Leave refused for the only owner says so in the dialog, and works once another owner is back", async () => {
  const person = {
    name: "Owen Second",
    email: "owen-second@example.com",
    password: PASSWORD,
  };
  const second = await system.addMember(person);
  await setRole(second.userId, "owner");
  const page = await openOrganization(person);
  await page.getByRole("button", { name: "Leave Organization" }).click();
  const dialog = page.getByRole("alertdialog");
  // The other owners step down meanwhile, the one signed in as the owner last, and the page has not
  // read the members since.
  const self = (await system.ownerAuth().getSession())?.user.id;
  const { members } = await system
    .ownerAuth()
    .organization.listMembers({ query: { organizationId } });
  const others = members
    .filter((member) => member.role === "owner" && member.userId !== second.userId)
    .toSorted((a, b) => Number(a.userId === self) - Number(b.userId === self));
  for (const member of others) await setRole(member.userId, "admin");
  const restore = async () => {
    for (const member of others)
      await setRole(member.userId, "owner", system.authClient(second.cookie));
  };
  const reads = await holdMemberReads(page);
  reads.start();
  const confirm = dialog.getByRole("button", { name: "Leave Organization" });
  await confirm.click();
  await expectBrowser(dialog.getByRole("alert")).toHaveText(
    "You cannot leave the organization as the only owner",
  );
  await expectBrowser(confirm).toBeFocused();
  await reads.arrived;
  await restore();
  reads.release();
  await confirm.click();
  await expectBrowser(page.getByRole("heading", { name: "Organization access" })).toBeFocused();
}, 30_000);

test("an invitation that expires under its open Revoke is still asked about, and can be revoked", async () => {
  const email = "expiring@example.com";
  const invitation = await system
    .ownerAuth()
    .organization.inviteMember({ organizationId, email, role: "member" });
  const page = await openOrganization(OWNER, { clock: true });
  const revoke = { name: `Revoke the invitation for ${email}` };
  await page.getByRole("button", revoke).click();
  const dialog = page.getByRole("alertdialog");
  const heading = `Revoke the invitation for ${email}?`;
  await expectBrowser(dialog.getByRole("heading")).toHaveText(heading);
  await page.clock.fastForward(new Date(invitation.expiresAt).getTime() - Date.now() + 60_000);
  await expectBrowser(page.getByRole("row").filter({ hasText: email })).toHaveCount(0);
  await expectBrowser(dialog.getByRole("heading")).toHaveText(heading);
  await dialog.getByRole("button", revoke).click();
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(
    page.getByRole("status").filter({ hasText: `The invitation for ${email} is revoked.` }),
  ).toBeFocused();
  expect(await system.owner().invitations.list()).not.toContainEqual(
    expect.objectContaining({ id: invitation.id }),
  );
}, 30_000);

test("a member removed elsewhere under an open Remove is already gone", async () => {
  const person = await system.addMember({ name: "Gone Gil", email: "gone-gil@example.com" });
  const page = await openOrganization();
  await page.getByRole("button", { name: "Remove Gone Gil" }).click();
  const dialog = page.getByRole("alertdialog");
  const { id } = await membershipOf(person.userId);
  await system.ownerAuth().organization.removeMember({ organizationId, memberIdOrEmail: id });
  await dialog.getByRole("button", { name: "Remove Gone Gil" }).click();
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(
    page.getByRole("status").filter({ hasText: "Gone Gil is already gone." }),
  ).toBeFocused();
  await expectBrowser(
    page.getByRole("row").filter({ hasText: "gone-gil@example.com" }),
  ).toHaveCount(0);
}, 30_000);

test("a Remove a fresh roster withdraws says why and cannot be confirmed", async () => {
  const adminEmail = "wanda@example.com";
  await addAdmin("Wanda", adminEmail);
  const person = await system.addMember({ name: "Rising Rui", email: "rising-rui@example.com" });
  onTestFinished(async () => {
    const { id } = await membershipOf(person.userId);
    await system.ownerAuth().organization.removeMember({ organizationId, memberIdOrEmail: id });
  });
  const page = await openOrganization({ email: adminEmail, password: PASSWORD });
  await page.getByRole("button", { name: "Remove Rising Rui" }).click();
  const dialog = page.getByRole("alertdialog");
  const confirm = dialog.getByRole("button", { name: "Remove Rising Rui" });
  await expectBrowser(confirm).toBeEnabled();
  await setRole(person.userId, "owner");
  await readAgain(page);
  await expectBrowser(dialog).toContainText("Only an owner can remove an owner.");
  await expectBrowser(dialog).not.toContainText("They can no longer read or change anything here");
  await expectBrowser(confirm).toBeDisabled();
  await expectBrowser(dialog.getByRole("heading")).toHaveText(
    "Remove Rising Rui from Organization?",
  );
}, 30_000);

test("leaving shows what happened, and nothing that acts on the Organization, until the session is read again", async () => {
  const person = { name: "Lena", email: "lena@example.com", password: PASSWORD };
  await system.addMember(person);
  const page = await openOrganization(person);
  const session = await holdReads(page, (url) => url.pathname === "/api/auth/get-session");
  await page.route("**/api/auth/organization/leave", async (route) => {
    session.start();
    await route.continue();
  });
  await page.getByRole("button", { name: "Leave Organization" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Leave Organization" }).click();
  await session.arrived;
  await expectBrowser(page.getByRole("alertdialog")).toHaveCount(0);
  await expectBrowser(
    page.getByRole("status").filter({ hasText: "You left Organization." }),
  ).toBeFocused();
  const main = page.getByRole("main");
  await expectBrowser(main.getByRole("button")).toHaveCount(0);
  await expectBrowser(main.getByRole("table")).toHaveCount(0);
  session.release();
  await expectBrowser(page.getByRole("heading", { name: "Organization access" })).toBeFocused();
}, 30_000);

test("an open confirmation leaves every row's controls inert, those of a row a read adds included", async () => {
  const auth = system.ownerAuth().organization;
  const first = await auth.inviteMember({
    organizationId,
    email: "inert-a@example.com",
    role: "member",
  });
  onTestFinished(async () => {
    await auth.cancelInvitation({ invitationId: first.id });
  });
  await system.addMember({ name: "Inert Ida", email: "inert-ida@example.com" });
  const page = await openOrganization();
  await page.getByRole("button", { name: "Revoke the invitation for inert-a@example.com" }).click();
  await expectBrowser(page.getByRole("alertdialog")).toBeVisible();
  const second = await auth.inviteMember({
    organizationId,
    email: "inert-b@example.com",
    role: "member",
  });
  onTestFinished(async () => {
    await auth.cancelInvitation({ invitationId: second.id });
  });
  await readAgain(page);
  const added = page.locator('button[aria-label="Revoke the invitation for inert-b@example.com"]');
  await added.waitFor({ state: "attached" });
  for (const trigger of [
    added,
    page.locator('button[aria-label="Revoke the invitation for inert-a@example.com"]'),
    page.locator('button[aria-label="Remove Inert Ida"]'),
  ])
    expect(await trigger.evaluate((element) => element.closest("[inert]") !== null)).toBe(true);
}, 30_000);
