import { expect } from "vite-plus/test";

import { aMember, memberOf, roster, signedIn, withRole } from "../records.ts";
import { readAgain, test, check } from "./dashboard.tsx";
import { arrangeOrganization } from "./organization.ts";

// The Organization page as an admin sees it.

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
  const field = dialog.getByLabelText("Email");
  const email = "mara@example.com";
  await field.fill(email);
  await check(dialog.getByRole("radio", { name: /^Member/ }));
  // A refusal of access can mean the role changed: the session is read again, and is held.
  const session = hub.session.hold();
  await dialog.getByRole("button", { name: "Create invitation" }).click();
  await session.arrived;
  await expect
    .element(field)
    .toHaveAccessibleDescription("This address has an invitation only an owner can replace.");
  await expect.element(field).toHaveAttribute("aria-invalid", "true");
  await expect.element(field).toHaveValue(email);
  await expect.element(field).toHaveFocus();
  expect(hub.auth.organization.inviteMember.calls).toEqual([
    { email, role: "member", organizationId: admin.session.activeOrganizationId },
  ]);
  await field.fill("another@example.com");
  await expect.element(field).not.toHaveAttribute("aria-invalid");
  session.release();
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
  await expect.element(dialog.getByRole("radio", { name: /^Owner/ })).toHaveLength(0);
  await check(dialog.getByRole("radio", { name: /^Member/ }));
  const demoted = withRole(admin, "member");
  hub.auth.organization.updateMemberRole.answers({ ...memberOf(admin), role: "member" });
  hub.auth.organization.listMembers.answers(roster(memberOf(demoted), owner));
  hub.session.answers(demoted);
  await dialog.getByRole("button", { name: "Change role" }).click();
  await expect
    .element(page.getByRole("status").filter({ hasText: "You are now a member." }))
    .toHaveFocus();
  // By part of its name, so a control that offers it under a longer name is absent too.
  const exact = false;
  await expect.element(page.getByRole("heading", { name: "Invitations", exact })).toHaveLength(0);
  await expect
    .element(page.getByRole("button", { name: "Invite a member", exact }))
    .toHaveLength(0);
  await expect
    .element(page.getByRole("button", { name: "Change role for yourself", exact }))
    .toHaveLength(0);
  await expect
    .element(
      page
        .getByRole("row")
        .filter({ hasText: admin.user.email })
        .getByRole("cell", { name: "Member" }),
    )
    .toBeVisible();
  expect(hub.auth.organization.updateMemberRole.calls).toEqual([
    { organizationId: owner.organizationId, memberId: memberOf(admin).id, role: "member" },
  ]);
});

test("an admin made a member by an owner elsewhere loses the management controls once the members are read", async ({
  hub,
  open,
}) => {
  const admin = signedIn("admin");
  const owner = aMember("Olive Owner", "owner");
  arrangeOrganization(hub, admin, owner);
  const page = await open("organization");
  const invite = page.getByRole("button", { name: "Invite a member" });
  const ownRole = page.getByRole("button", { name: "Change role for yourself" });
  await expect.element(invite).toBeVisible();
  await expect.element(ownRole).toBeVisible();

  const demoted = withRole(admin, "member");
  hub.auth.organization.listMembers.answers(roster(memberOf(demoted), owner));
  hub.session.answers(demoted);
  readAgain();
  // By part of its name, so a control that offers it under a longer name is absent too.
  const exact = false;
  await expect
    .element(page.getByRole("button", { name: "Invite a member", exact }))
    .toHaveLength(0);
  await expect.element(page.getByRole("heading", { name: "Invitations", exact })).toHaveLength(0);
  await expect
    .element(page.getByRole("button", { name: "Change role for yourself", exact }))
    .toHaveLength(0);
});

test("a failed keys read leaves members and invitations usable and explains the missing counts", async ({
  hub,
  open,
}) => {
  arrangeOrganization(hub, signedIn("admin"), aMember("Olive Owner", "owner"), aMember("River"));
  hub.apiKeys.list.refuses("FORBIDDEN");
  const page = await open("organization");
  await expect.element(page.getByRole("heading", { name: "Invitations" })).toBeVisible();
  await expect
    .element(page.getByRole("alert"))
    .toMatchTextContent("The API keys could not be read");
  const dialog = page.getByRole("alertdialog");
  await page.getByRole("button", { name: "Remove River" }).click();
  await expect
    .element(dialog.getByRole("alert"))
    .toMatchTextContent("The API keys could not be read");
  await expect.element(dialog).toMatchTextContent("API keys created by River keep working.");
  await dialog.getByRole("button", { name: "Keep them" }).click();
  await page.getByRole("button", { name: "Leave Lodge" }).click();
  await expect
    .element(dialog.getByRole("alert"))
    .toMatchTextContent("The API keys could not be read");
  await expect.element(dialog).toMatchTextContent("API keys you created keep working.");
  await dialog.getByRole("button", { name: "Stay" }).click();
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
  await expect.element(dialog).toHaveLength(0);
  await expect
    .element(page.getByRole("status").filter({ hasText: "Gone Gil is already gone." }))
    .toHaveFocus();
  await expect.element(page.getByRole("row").filter({ hasText: "Gone Gil" })).toHaveLength(0);
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
  await expect
    .element(dialog.getByRole("alert"))
    .toHaveTextContent("Only an owner can remove an owner.");
  await held.arrived;
  hub.auth.organization.listMembers.answers(
    roster(memberOf(admin), owner, { ...pia, role: "owner" }),
  );
  held.release();
  await expect.element(confirm).toBeDisabled();
  await expect.element(dialog.getByText("Only an owner can remove an owner.")).toHaveLength(1);
  await expect
    .element(dialog.getByRole("alert"))
    .toHaveTextContent("Only an owner can remove an owner.");
});
