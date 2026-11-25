import { expect } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser/context";

import { aMember, anApiKey, memberOf, roster, signedIn, withoutMembership } from "../records.ts";
import { advanceTo, focus, readAgain, test, texts, UNCERTAIN, check } from "./dashboard.tsx";
import { arrangeOrganization } from "./organization.ts";

// The Organization page as an owner sees it.

test("removing a member identifies their active keys and explains what happens to pending invitations", async ({
  hub,
  open,
}) => {
  const mei = aMember("Mei Tanaka", "admin");
  const creator = { id: mei.userId, name: mei.user.name, isMember: true };
  arrangeOrganization(hub, signedIn("owner"), mei);
  const importer = anApiKey("Importer", { creator });
  hub.apiKeys.list.answers([importer]);
  const page = await open("organization");

  const dialog = page.getByRole("dialog");
  await page.getByRole("button", { name: "Change role for Mei Tanaka" }).click();
  await check(dialog.getByRole("radio", { name: /^Member/ }));
  await expect
    .element(dialog)
    .toMatchTextContent("1 active API key created by Mei Tanaka keeps working.");
  await expect.element(dialog).toMatchTextContent("Pending invitations stay valid.");
  // Selecting the current role has no consequences.
  await check(dialog.getByRole("radio", { name: /^Admin/ }));
  await expect.element(dialog).not.toMatchTextContent("Pending invitations stay valid.");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Remove Mei Tanaka" }).click();
  const confirmation = page.getByRole("alertdialog");
  await expect
    .element(confirmation)
    .toMatchTextContent(
      "1 active API key created by Mei Tanaka keeps working. Review it under API keys, and the Runners registered with it under Runners.",
    );
  await expect.element(confirmation).toMatchTextContent("Pending invitations stay valid.");
  hub.auth.organization.removeMember.answers({ member: mei });
  const removal = hub.auth.organization.removeMember.hold();
  await confirmation.getByRole("button", { name: "Remove Mei Tanaka" }).click();
  expect(await removal.arrived).toEqual({
    memberIdOrEmail: mei.id,
    organizationId: mei.organizationId,
  });
  await expect.element(confirmation).toMatchTextContent("Working…");
  // The explanation's links stay in place but lead nowhere while the answer is to come.
  const keysLink = confirmation.getByRole("link", { name: "API keys" });
  await expect.element(keysLink).toHaveAttribute("aria-disabled", "true");
  await expect.element(keysLink).not.toHaveAttribute("href");

  hub.auth.organization.listMembers.answers(roster(memberOf(signedIn("owner"))));
  hub.invitations.list.answers([]);
  hub.apiKeys.list.answers([{ ...importer, creator: { ...creator, isMember: false } }]);
  removal.release();
  await expect
    .element(page.getByRole("status").filter({ hasText: "Mei Tanaka is removed." }))
    .toHaveFocus();
  await page
    .getByRole("navigation", { name: "Destinations" })
    .getByRole("link", { name: "API keys" })
    .click();
  await expect
    .element(page.getByRole("row").filter({ hasText: "Importer" }))
    .toMatchTextContent("Mei Tanaka (no longer a member)");
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
  await focus(rename);
  await userEvent.keyboard("{Enter}");
  expect(await renaming.arrived).toEqual({
    organizationId: organization.id,
    data: { name: "Renamed Lodge" },
  });
  await expect.element(dialog.getByText("Working…")).toBeVisible();
  await expect.poll(() => readOnly(name.element())).toBe(true);

  // The dialog closes on the hub's answer, with focus on the notice, while the session read that
  // renames the page is still under way.
  const session = hub.session.hold();
  renaming.release();
  await session.arrived;
  await expect.element(dialog).toHaveLength(0);
  await expect
    .element(page.getByRole("status").filter({ hasText: "Renamed to Renamed Lodge." }))
    .toHaveFocus();
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
  await check(dialog.getByRole("radio", { name: /^Admin/ }));
  const change = hub.auth.organization.updateMemberRole.hold();
  const arrival = change.arrived.then(() => Date.now());
  await dialog.getByRole("button", { name: "Change role" }).click();
  await change.arrived;
  // The deadline runs from before the request arrived, and these steps go to fixed times after the
  // clock's reading at its arrival, so the deadline is held to between 29 and 30 seconds after it
  // however far the clock has moved since. Checked without retrying, since Vitest moves the clock
  // while any assertion retries.
  const arrivedAt = await arrival;
  await advanceTo(arrivedAt + 29_000);
  expect(texts(dialog)[0]).toContain("Working…");
  expect(dialog.getByRole("alert").elements()).toHaveLength(0);
  await advanceTo(arrivedAt + 30_000);
  expect(texts(dialog.getByRole("alert"))).toEqual([UNCERTAIN]);
  await expect
    .element(dialog.getByRole("button", { name: "Cancel" }))
    .not.toHaveAttribute("aria-disabled");
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
  await check(admin);
  const send = dialog.getByRole("button", { name: "Change role" });
  await focus(send);
  hub.auth.organization.listMembers.answers(roster(memberOf(owner)));
  readAgain();
  await expect.element(dialog).toMatchTextContent("Leaving Lev is no longer a member.");
  await expect.element(send).toBeDisabled();
  await expect.element(send).toHaveFocus();
  await expect
    .element(dialog.getByRole("heading"))
    .toHaveTextContent("Change the role of Leaving Lev");
  // Enter in a field presses the button that sends, which refuses it. The stand-in has no answer
  // for a change of role, so one sent would fail the test.
  await focus(admin);
  await userEvent.keyboard("{Enter}");
  await expect.element(dialog).toBeVisible();
  // By part of its text, so a longer line that still says it is absent too.
  await expect.element(dialog.getByText("Working…", { exact: false })).toHaveLength(0);
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
  await expect
    .element(dialog.getByRole("alert"))
    .toHaveTextContent("You cannot leave the organization as the only owner");
  await expect.element(confirm).toHaveFocus();
  await reads.arrived;
  hub.auth.organization.listMembers.answers(roster(memberOf(owner), { ...other, role: "admin" }));
  reads.release();
  await expect
    .element(dialog)
    .toMatchTextContent("You are now the only owner, so you cannot leave or change your own role.");
  await expect.element(confirm).toBeDisabled();

  hub.auth.organization.listMembers.answers(roster(memberOf(owner), other));
  readAgain();
  await expect.element(confirm).toBeEnabled();
  hub.auth.organization.leave.answers({ ...memberOf(owner) });
  hub.session.answers(withoutMembership(owner));
  await confirm.click();
  await expect.element(page.getByRole("heading", { name: "Organization access" })).toHaveFocus();
  await expect.poll(() => document.title).toBe("Organization access · Elflodge");
});

/** Whether `element` is a text field that takes no typing, as Playwright reads `readOnly`. */
function readOnly(element: Element) {
  return element instanceof HTMLInputElement && element.readOnly;
}
