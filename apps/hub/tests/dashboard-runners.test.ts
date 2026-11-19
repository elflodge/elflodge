import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, expect, onTestFinished, test } from "vite-plus/test";

import { launchDashboardBrowser } from "./dashboard-browser.ts";
import { OWNER, startSystem } from "./harness.ts";

// The dashboard's Runners and API keys pages, as browsers reach them through the hub, on both
// runtimes.

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

/** Opens the dashboard's `pathname` in a new page, signed out, and signs in there as `member`. */
async function signedInAt(
  pathname: string,
  member: { email: string; password: string } = OWNER,
): Promise<Page> {
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  await page.goto(`${system.origin}/dashboard/${pathname}`);
  await page.getByLabel("Email").fill(member.email);
  await page.getByLabel("Password").fill(member.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${system.origin}/dashboard/${pathname}`);
  return page;
}

/** Registers a Runner named `name`, as a host does with a registration key, and returns its ID. */
async function registerRunner(name: string): Promise<string> {
  const registration = system.runnerClient({ "x-api-key": await system.createRegistrationKey() });
  const { id } = await registration.register({ name });
  return id;
}

/** The Runners page's record of the Runner whose heading starts with `name`. */
function runnerRecord(page: Page, name: string) {
  return page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: new RegExp(`^${name} `) }) });
}

test("in a browser, the Runners page lists a registered Runner by its name and short ID", async () => {
  const id = await registerRunner("lodge-01");
  const page = await signedInAt("");
  // The strip's count of Runners leads to the page.
  await page
    .getByRole("region", { name: "The hub now" })
    .getByRole("link", { name: /^Runners / })
    .click();
  await page.waitForURL(`${system.origin}/dashboard/runners`);
  // Host names repeat, so the short ID goes with the name.
  await page.getByRole("heading", { name: `lodge-01 ${id.slice(0, 8)}` }).waitFor();
}, 30_000);

test("in a browser, Add Runner gives a command naming this hub, and creates a key only when asked", async () => {
  const before = await system.owner().apiKeys.list();
  const page = await signedInAt("runners");
  await page.getByRole("button", { name: "Add Runner" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add Runner" });
  const command = dialog.getByLabel("The command to run on the machine");
  expect(await command.innerText()).toContain(`HUB_URL=${system.origin}\n`);
  expect(await command.innerText()).toContain("RUNNER_REGISTRATION_KEY=<a registration key>");
  // Opening it created nothing.
  expect(await system.owner().apiKeys.list()).toHaveLength(before.length);

  await dialog.getByRole("button", { name: "Create a registration key" }).click();
  await dialog.getByText("Shown this once:").waitFor();
  const key = /RUNNER_REGISTRATION_KEY=(\S+)/.exec(await command.innerText())?.[1] ?? "";
  // The key in the command registers a Runner, and is an ordinary key, listed with the others.
  await system.runnerClient({ "x-api-key": key }).register({ name: "new-host" });
  const created = (await system.owner().apiKeys.list()).filter(
    (listed) => !before.some((earlier) => earlier.id === listed.id),
  );
  expect(created).toEqual([
    expect.objectContaining({ permissions: { runner: ["register"] }, expiresAt: expect.any(Date) }),
  ]);
}, 30_000);

test("in a browser, removing a Runner takes it off the list", async () => {
  const id = await registerRunner("retired-host");
  const page = await signedInAt("runners");
  const record = runnerRecord(page, "retired-host");
  await record.getByRole("button", { name: /^Remove / }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: `Remove retired-host ${id.slice(0, 8)}` })
    .click();
  await record.waitFor({ state: "detached" });
  await page.getByRole("status").filter({ hasText: "is removed" }).waitFor();
  expect(await system.findRunner(id)).toBeUndefined();
}, 30_000);

test("in a browser, a new API key is shown once", async () => {
  const page = await signedInAt("api-keys");
  await page.getByRole("button", { name: "Create key" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("nightly report");
  await dialog.getByRole("group", { name: "Jobs" }).getByLabel("read").check();
  await dialog.getByRole("button", { name: "Create key" }).click();
  const key = (await dialog.getByLabel("The new API key").innerText()).trim();
  // The key holds what was granted.
  await system.client({ "x-api-key": key }).jobs.counts({});
  const row = page.getByRole("row").filter({ hasText: "nightly report" });
  await row.getByText("job: read").waitFor();
  // Closing the dialog forgets it.
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect.poll(() => page.content()).not.toContain(key);

  await page.reload();
  await row.waitFor();
  expect(await page.content()).not.toContain(key);
}, 30_000);

test("in a browser, a revoked API key leaves the list and stops working", async () => {
  const { key } = await system.owner().apiKeys.create({
    name: "old script",
    permissions: { job: ["read"] },
  });
  const page = await signedInAt("api-keys");
  const row = page.getByRole("row").filter({ hasText: "old script" });
  await row.getByRole("button", { name: /^Revoke / }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^Revoke old script/ })
    .click();
  await row.waitFor({ state: "detached" });
  await expect(system.client({ "x-api-key": key }).jobs.counts({})).rejects.toThrow();
}, 30_000);

test("in a browser, a plain member gets no owner's actions on Runners and API keys", async () => {
  await registerRunner("shared-host");
  const member = {
    name: "Plain Member",
    email: "plain.member@example.com",
    password: "a long enough password",
  };
  await system.addMember(member);
  const page = await signedInAt("runners", member);
  const record = runnerRecord(page, "shared-host");
  await record.waitFor();
  expect(await record.getByRole("button", { name: /^Remove / }).count()).toBe(0);

  // Add Runner gives the command, for a key the member holds.
  await page.getByRole("button", { name: "Add Runner" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add Runner" });
  expect(await dialog.getByLabel("The command to run on the machine").innerText()).toContain(
    "RUNNER_REGISTRATION_KEY=<a registration key>",
  );
  expect(await dialog.getByRole("button", { name: "Create a registration key" }).count()).toBe(0);
  await dialog.getByRole("button", { name: "Close" }).click();

  await page
    .getByRole("navigation", { name: "Destinations" })
    .getByRole("link", { name: "API keys" })
    .click();
  await page.getByText("Only owners and admins see and manage").waitFor();
  expect(await page.getByRole("button", { name: "Create key" }).count()).toBe(0);
}, 30_000);
