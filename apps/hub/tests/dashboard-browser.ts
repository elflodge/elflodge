import type { Page } from "playwright";
import { chromium } from "playwright";

import type { startSystem } from "./harness.ts";

type System = ReturnType<typeof startSystem>;

/** The hub accepts sign-in only from its own origin. Resolve that host to the local test hub. */
export function launchDashboardBrowser(system: { origin: string; url(): URL }) {
  return chromium.launch({
    args: [`--host-resolver-rules=MAP ${new URL(system.origin).hostname} ${system.url().host}`],
  });
}

/** A member of the Organization named `name`, added to it, whom a browser can sign in as. */
export async function newMember(system: System, name: string) {
  const member = {
    name,
    email: `${name.toLowerCase().replaceAll(" ", ".")}@example.com`,
    password: "a long enough password",
  };
  await system.addMember(member);
  return member;
}

/**
 * Opens the dashboard's `pathname` in `page`, signed out, and signs in there as `member`, which
 * leads back to `landing`, by default `pathname`.
 */
export async function signInAt(
  system: System,
  page: Page,
  pathname: string,
  member: { email: string; password: string },
  landing = pathname,
) {
  await page.goto(`${system.origin}/dashboard/${pathname}`);
  await page.getByLabel("Email").fill(member.email);
  await page.getByLabel("Password").fill(member.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${system.origin}/dashboard/${landing}`);
}
