import { expect } from "vite-plus/test";

import { aMember, memberOf, roster, signedIn, withoutMembership } from "../records.ts";
import { test } from "./dashboard.tsx";

// The Organization page as a plain member sees it.

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
  await expect.element(page.getByRole("alertdialog")).toHaveLength(0);
  await expect
    .element(page.getByRole("status").filter({ hasText: "You left Lodge." }))
    .toHaveFocus();
  const main = page.getByRole("main");
  await expect.element(main.getByRole("button")).toHaveLength(0);
  await expect.element(main.getByRole("table")).toHaveLength(0);
  hub.session.answers(withoutMembership(member));
  session.release();
  await expect.element(page.getByRole("heading", { name: "Organization access" })).toHaveFocus();
});
