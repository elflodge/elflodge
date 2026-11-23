import { expect } from "vite-plus/test";

import type { Member } from "../src/organization.ts";
import { expectBrowser, readAgain, test, UNCERTAIN } from "./dashboard.ts";
import type { Hub, Session } from "./hub.ts";
import {
  aMember,
  anApiKey,
  anInvitation,
  memberOf,
  roster,
  signedIn,
  withoutMembership,
  withRole,
} from "./records.ts";

// The Organization page: inviting, changing roles, removing members, leaving and renaming, against
// Better Auth's routes and the hub's lists of invitations and API keys.

/**
 * Arranges what the page reads for `session`'s member, listed among `others`: the members, and for
 * an owner or admin, no invitations and no keys unless a test arranges them.
 */
function arrangeOrganization(hub: Hub, session: NonNullable<Session>, ...others: Member[]) {
  hub.session.answers(session);
  hub.auth.organization.listMembers.answers(roster(memberOf(session), ...others));
  hub.invitations.list.answers([]);
  hub.apiKeys.list.answers([]);
}

test("the email field explains why an admin cannot replace an owner invitation", async ({
  hub,
  open,
}) => {
  const admin = signedIn("admin");
  arrangeOrganization(hub, admin, aMember("Olive Owner", "owner"));
  // The hub refuses a Member grant to an address that has an owner invitation.
  hub.auth.organization.inviteMember.refuses(
    "FORBIDDEN",
    "YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE",
  );
  const page = await open("organization");
  await page.getByRole("button", { name: "Invite a member" }).click();
  const dialog = page.getByRole("dialog");
  const field = dialog.getByLabel("Email");
  const email = "mara@example.com";
  await field.fill(email);
  await dialog.getByRole("radio", { name: /^Member/ }).check();
  // A refusal of access can mean the role changed: the session is read again, and is held.
  const session = hub.session.hold();
  await dialog.getByRole("button", { name: "Create invitation" }).click();
  await session.arrived;
  await expectBrowser(field).toHaveAccessibleDescription(
    "This address has an invitation only an owner can replace.",
  );
  await expectBrowser(field).toHaveAttribute("aria-invalid", "true");
  await expectBrowser(field).toHaveValue(email);
  await expectBrowser(field).toBeFocused();
  expect(hub.auth.organization.inviteMember.calls).toEqual([
    { email, role: "member", organizationId: admin.session.activeOrganizationId },
  ]);
  await field.fill("another@example.com");
  await expectBrowser(field).not.toHaveAttribute("aria-invalid");
  session.release();
});

test("removing a member counts their active keys and invitations and keeps their keys identifiable", async ({
  hub,
  open,
}) => {
  const mei = aMember("Mei Tanaka", "admin");
  const creator = { id: mei.userId, name: mei.user.name, isMember: true };
  arrangeOrganization(hub, signedIn("owner"), mei);
  hub.invitations.list.answers([
    anInvitation("teo@example.com", { inviter: { id: mei.userId, name: mei.user.name } }),
  ]);
  const importer = anApiKey("Importer", { creator });
  hub.apiKeys.list.answers([importer]);
  const page = await open("organization");

  const dialog = page.getByRole("dialog");
  await page.getByRole("button", { name: "Change role for Mei Tanaka" }).click();
  await dialog.getByRole("radio", { name: /^Member/ }).check();
  await expectBrowser(dialog).toContainText(
    "1 active API key created by Mei Tanaka keeps working.",
  );
  await expectBrowser(dialog).toContainText("Their 1 pending invitation stops working.");
  // An admin keeps the invitations that do not grant owner.
  await dialog.getByRole("radio", { name: /^Admin/ }).check();
  await expectBrowser(dialog).not.toContainText("pending invitation");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Remove Mei Tanaka" }).click();
  const confirmation = page.getByRole("alertdialog");
  await expectBrowser(confirmation).toContainText(
    "1 active API key created by Mei Tanaka keeps working. Review it under API keys, and the Runners registered with it under Runners.",
  );
  await expectBrowser(confirmation).toContainText("Their 1 pending invitation stops working.");
  hub.auth.organization.removeMember.answers({ member: mei });
  const removal = hub.auth.organization.removeMember.hold();
  await confirmation.getByRole("button", { name: "Remove Mei Tanaka" }).click();
  expect(await removal.arrived).toEqual({
    memberIdOrEmail: mei.id,
    organizationId: mei.organizationId,
  });
  await expectBrowser(confirmation).toContainText("Working…");
  // The explanation's links stay in place but lead nowhere while the answer is to come.
  const keysLink = confirmation.getByRole("link", { name: "API keys" });
  await expectBrowser(keysLink).toHaveAttribute("aria-disabled", "true");
  await expectBrowser(keysLink).not.toHaveAttribute("href");

  hub.auth.organization.listMembers.answers(roster(memberOf(signedIn("owner"))));
  hub.invitations.list.answers([]);
  hub.apiKeys.list.answers([{ ...importer, creator: { ...creator, isMember: false } }]);
  removal.release();
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
});

test("an admin changing their own role immediately loses the management controls", async ({
  hub,
  open,
}) => {
  const admin = signedIn("admin");
  const owner = aMember("Olive Owner", "owner");
  arrangeOrganization(hub, admin, owner);
  const page = await open("organization");
  await page.getByRole("button", { name: "Change role for yourself" }).click();
  const dialog = page.getByRole("dialog");
  await expectBrowser(dialog.getByRole("radio", { name: /^Owner/ })).toHaveCount(0);
  await dialog.getByRole("radio", { name: /^Member/ }).check();
  const demoted = withRole(admin, "member");
  hub.auth.organization.updateMemberRole.answers({ ...memberOf(admin), role: "member" });
  hub.auth.organization.listMembers.answers(roster(memberOf(demoted), owner));
  hub.session.answers(demoted);
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
      .filter({ hasText: admin.user.email })
      .getByRole("cell", { name: "Member", exact: true }),
  ).toBeVisible();
  expect(hub.auth.organization.updateMemberRole.calls).toEqual([
    { organizationId: owner.organizationId, memberId: memberOf(admin).id, role: "member" },
  ]);
});

test("Rename keeps the name read-only while the hub answers, and its notice takes focus before the session is read again", async ({
  hub,
  open,
}) => {
  const owner = signedIn("owner");
  arrangeOrganization(hub, owner);
  const page = await open("organization");
  await page.getByRole("button", { name: "Rename" }).click();
  const dialog = page.getByRole("dialog");
  const name = dialog.getByRole("textbox", { name: "Name" });
  await name.fill("Renamed Lodge");
  const organization = owner.membership.status === "member" ? owner.membership.organization : null;
  if (!organization) throw new Error("The owner has no Organization");
  hub.auth.organization.update.answers({
    ...organization,
    name: "Renamed Lodge",
    slug: "lodge",
    createdAt: owner.user.createdAt,
  });
  const renaming = hub.auth.organization.update.hold();
  const rename = dialog.getByRole("button", { name: "Rename" });
  await rename.press("Enter");
  expect(await renaming.arrived).toEqual({
    organizationId: organization.id,
    data: { name: "Renamed Lodge" },
  });
  await expectBrowser(dialog.getByText("Working…")).toBeVisible();
  await expectBrowser(name).toHaveJSProperty("readOnly", true);

  // The dialog closes on the hub's answer, with focus on the notice, while the session read that
  // renames the page is still under way.
  const session = hub.session.hold();
  renaming.release();
  await session.arrived;
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(
    page.getByRole("status").filter({ hasText: "Renamed to Renamed Lodge." }),
  ).toBeFocused();
  session.release();
});

test("a Change role the hub never answers ends after 30 seconds by saying it may have been done", async ({
  hub,
  open,
}) => {
  const quinn = aMember("Quiet Quinn");
  arrangeOrganization(hub, signedIn("owner"), quinn);
  hub.auth.organization.updateMemberRole.answers({ ...quinn, role: "admin" });
  const page = await open("organization");
  await page.getByRole("button", { name: "Change role for Quiet Quinn" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: /^Admin/ }).check();
  const change = hub.auth.organization.updateMemberRole.hold();
  await dialog.getByRole("button", { name: "Change role" }).click();
  await change.arrived;
  await page.clock.runFor(29_999);
  await expectBrowser(dialog).toContainText("Working…");
  await expectBrowser(dialog.getByRole("alert")).toHaveCount(0);
  await page.clock.runFor(1);
  await expectBrowser(dialog.getByRole("alert")).toHaveText(UNCERTAIN);
  await expectBrowser(dialog.getByRole("button", { name: "Cancel" })).not.toHaveAttribute(
    "aria-disabled",
  );
});

test("a Change role for a member who left meanwhile says so and sends nothing", async ({
  hub,
  open,
}) => {
  const owner = signedIn("owner");
  arrangeOrganization(hub, owner, aMember("Leaving Lev"));
  const page = await open("organization");
  await page.getByRole("button", { name: "Change role for Leaving Lev" }).click();
  const dialog = page.getByRole("dialog");
  const admin = dialog.getByRole("radio", { name: /^Admin/ });
  await admin.check();
  const send = dialog.getByRole("button", { name: "Change role" });
  await send.focus();
  hub.auth.organization.listMembers.answers(roster(memberOf(owner)));
  await readAgain(page);
  await expectBrowser(dialog).toContainText("Leaving Lev is no longer a member.");
  await expectBrowser(send).toBeDisabled();
  await expectBrowser(send).toBeFocused();
  await expectBrowser(dialog.getByRole("heading")).toHaveText("Change the role of Leaving Lev");
  // Enter in a field presses the button that sends, which refuses it. The stand-in has no answer
  // for a change of role, so one sent would fail the test.
  await admin.press("Enter");
  await expectBrowser(dialog).toBeVisible();
  await expectBrowser(dialog.getByText("Working…")).toHaveCount(0);
});

test("a failed keys read leaves members and invitations usable and explains the missing counts", async ({
  hub,
  open,
}) => {
  arrangeOrganization(hub, signedIn("admin"), aMember("Olive Owner", "owner"), aMember("River"));
  hub.apiKeys.list.refuses("FORBIDDEN");
  const page = await open("organization");
  await expectBrowser(page.getByRole("heading", { name: "Invitations" })).toBeVisible();
  await expectBrowser(page.getByRole("alert")).toContainText("The API keys could not be read");
  const dialog = page.getByRole("alertdialog");
  await page.getByRole("button", { name: "Remove River" }).click();
  await expectBrowser(dialog.getByRole("alert")).toContainText("The API keys could not be read");
  await expectBrowser(dialog).toContainText("API keys created by River keep working.");
  await dialog.getByRole("button", { name: "Keep them" }).click();
  await page.getByRole("button", { name: "Leave Lodge" }).click();
  await expectBrowser(dialog.getByRole("alert")).toContainText("The API keys could not be read");
  await expectBrowser(dialog).toContainText("API keys you created keep working.");
  await dialog.getByRole("button", { name: "Stay" }).click();
  await page
    .getByRole("navigation", { name: "Destinations" })
    .getByRole("link", { name: "API keys" })
    .click();
  await expectBrowser(page.getByRole("heading", { name: "API keys" })).toBeVisible();
  await expectBrowser(page.getByRole("alert")).toContainText("The API keys could not be read");
});

test("a Leave refused for the only owner says so, is withdrawn once the members are read, and works once another owner is back", async ({
  hub,
  open,
}) => {
  const owner = signedIn("owner");
  const other = aMember("Olive Owner", "owner");
  arrangeOrganization(hub, owner, other);
  const page = await open("organization");
  await page.getByRole("button", { name: "Leave Lodge" }).click();
  const dialog = page.getByRole("alertdialog");
  // The other owner steps down meanwhile, and the page has not read the members since.
  hub.auth.organization.leave.refuses(
    "BAD_REQUEST",
    "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER",
  );
  const reads = hub.auth.organization.listMembers.hold();
  const confirm = dialog.getByRole("button", { name: "Leave Lodge" });
  await confirm.click();
  // Better Auth's own words.
  await expectBrowser(dialog.getByRole("alert")).toHaveText(
    "You cannot leave the organization as the only owner",
  );
  await expectBrowser(confirm).toBeFocused();
  await reads.arrived;
  hub.auth.organization.listMembers.answers(roster(memberOf(owner), { ...other, role: "admin" }));
  reads.release();
  await expectBrowser(dialog).toContainText(
    "You are now the only owner, so you cannot leave or change your own role.",
  );
  await expectBrowser(confirm).toBeDisabled();

  hub.auth.organization.listMembers.answers(roster(memberOf(owner), other));
  await readAgain(page);
  await expectBrowser(confirm).toBeEnabled();
  hub.auth.organization.leave.answers({ ...memberOf(owner) });
  hub.session.answers(withoutMembership(owner));
  await confirm.click();
  await expectBrowser(page.getByRole("heading", { name: "Organization access" })).toBeFocused();
  await expectBrowser(page).toHaveTitle("Organization access · Elflodge");
});

test("a Remove the members list has overtaken says why: one removed elsewhere is gone, one made an owner only an owner can remove", async ({
  hub,
  open,
}) => {
  const admin = signedIn("admin");
  const owner = aMember("Olive Owner", "owner");
  const gil = aMember("Gone Gil");
  const pia = aMember("Promoted Pia");
  arrangeOrganization(hub, admin, owner, gil, pia);
  const page = await open("organization");
  const dialog = page.getByRole("alertdialog");

  // Removed elsewhere: Better Auth finds no such member, and one read of the members, which the
  // page writes without reading them again, says they are gone.
  await page.getByRole("button", { name: "Remove Gone Gil" }).click();
  hub.auth.organization.removeMember.refuses("BAD_REQUEST", "MEMBER_NOT_FOUND");
  hub.auth.organization.listMembers.answers(roster(memberOf(admin), owner, pia));
  const reads = hub.auth.organization.listMembers.calls.length;
  await dialog.getByRole("button", { name: "Remove Gone Gil" }).click();
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(
    page.getByRole("status").filter({ hasText: "Gone Gil is already gone." }),
  ).toBeFocused();
  await expectBrowser(page.getByRole("row").filter({ hasText: "Gone Gil" })).toHaveCount(0);
  expect(hub.auth.organization.listMembers.calls).toHaveLength(reads + 1);

  // Made an owner elsewhere: Better Auth's refusal arrives before the read of the members that
  // would withdraw Remove with the same sentence, which then shows once, in the alert.
  await page.getByRole("button", { name: "Remove Promoted Pia" }).click();
  hub.auth.organization.removeMember.refuses(
    "BAD_REQUEST",
    "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER",
  );
  const held = hub.auth.organization.listMembers.hold();
  const confirm = dialog.getByRole("button", { name: "Remove Promoted Pia" });
  await confirm.click();
  await expectBrowser(dialog.getByRole("alert")).toHaveText("Only an owner can remove an owner.");
  await held.arrived;
  hub.auth.organization.listMembers.answers(
    roster(memberOf(admin), owner, { ...pia, role: "owner" }),
  );
  held.release();
  await expectBrowser(confirm).toBeDisabled();
  await expectBrowser(dialog.getByText("Only an owner can remove an owner.")).toHaveCount(1);
  await expectBrowser(dialog.getByRole("alert")).toHaveText("Only an owner can remove an owner.");
});

test("leaving shows what happened, and nothing that acts on the Organization, until the session is read again", async ({
  hub,
  open,
}) => {
  const member = signedIn("member");
  hub.session.answers(member);
  hub.auth.organization.listMembers.answers(
    roster(aMember("Olive Owner", "owner"), memberOf(member)),
  );
  hub.auth.organization.leave.answers({ ...memberOf(member) });
  const page = await open("organization");
  await page.getByRole("button", { name: "Leave Lodge" }).click();
  const session = hub.session.hold();
  await page.getByRole("alertdialog").getByRole("button", { name: "Leave Lodge" }).click();
  await session.arrived;
  await expectBrowser(page.getByRole("alertdialog")).toHaveCount(0);
  await expectBrowser(
    page.getByRole("status").filter({ hasText: "You left Lodge." }),
  ).toBeFocused();
  const main = page.getByRole("main");
  await expectBrowser(main.getByRole("button")).toHaveCount(0);
  await expectBrowser(main.getByRole("table")).toHaveCount(0);
  hub.session.answers(withoutMembership(member));
  session.release();
  await expectBrowser(page.getByRole("heading", { name: "Organization access" })).toBeFocused();
});
