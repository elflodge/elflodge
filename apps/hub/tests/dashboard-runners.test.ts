import type { Browser, Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
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

test("revoking the last API key returns focus to the page and stops calls with that key", async () => {
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
  await expectBrowser(
    page.getByRole("status").filter({ hasText: /^old script .* is revoked\.$/ }),
  ).toBeVisible();
  await page.getByRole("heading", { name: "No API keys" }).waitFor();
  await expectBrowser(page.getByRole("heading", { name: "API keys", exact: true })).toBeFocused();
  await expect(system.client({ "x-api-key": key }).jobs.counts({})).rejects.toThrow();
}, 30_000);

test("dismissing a pending revocation still announces a refusal on the page", async () => {
  const { id } = await system.owner().apiKeys.create({
    name: "scheduled job",
    permissions: { job: ["read"] },
  });
  const page = await signedInAt("api-keys");
  const release = Promise.withResolvers<void>();
  await page.route(`**/api-keys/${id}`, async (route) => {
    await release.promise;
    await route.continue();
  });
  const revoke = { name: /^Revoke scheduled job / };
  await page.getByRole("button", revoke).click();
  const dialog = page.getByRole("dialog");
  try {
    await dialog.getByRole("button", revoke).click();
    await expectBrowser(dialog.getByRole("status")).toHaveText("Working…");
    await page.keyboard.press("Escape");
    await expectBrowser(dialog).toHaveCount(0);
    const signedOut = await page.evaluate(
      async () =>
        (
          await fetch("/api/auth/sign-out", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        ).ok,
    );
    expect(signedOut).toBe(true);
  } finally {
    release.resolve();
  }
  await expectBrowser(
    page.getByRole("alert").filter({ hasText: /Revoke scheduled job/ }),
  ).toHaveText(/Revoke scheduled job .*: Unauthorized/);
}, 30_000);

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

test("in a browser, Add Runner gives a command for another machine, and creates a key only when asked", async () => {
  const before = await system.owner().apiKeys.list();
  const page = await signedInAt("runners");
  await page.getByRole("button", { name: "Add Runner" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Runner" });
  const command = dialog.getByLabel("The command to run on the machine");
  await expectBrowser(
    dialog.getByText("Waiting for a Runner to register.", { exact: false }),
  ).toBeVisible();
  expect(await command.innerText()).toContain("<a registration key>");
  const text = await command.innerText();
  expect(text).toContain("HUB_URL=<the hub's URL from that machine>");
  expect(text).not.toContain(system.origin);
  // Opening it created nothing.
  expect(await system.owner().apiKeys.list()).toHaveLength(before.length);

  await dialog.getByRole("button", { name: "Create a registration key" }).click();
  await dialog.getByText("Shown this once:").waitFor();
  await expectBrowser(dialog.getByRole("button", { name: "Copy the command" })).toBeFocused();
  const key = await command.locator("mark.key").innerText();
  // The key in the command registers a Runner, and is an ordinary key, listed with the others.
  const { id } = await system.runnerClient({ "x-api-key": key }).register({ name: "new-host" });
  await expectBrowser(dialog.getByRole("status").filter({ hasText: "has registered." })).toHaveText(
    `new-host ${id.slice(0, 8)} has registered.`,
    { timeout: 10_000 },
  );
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
  await expectBrowser(page.getByRole("status").filter({ hasText: "is removed" })).toBeFocused();
  expect(await system.findRunner(id)).toBeUndefined();
}, 30_000);

test("removing an already removed Runner closes the dialog and explains its absence", async () => {
  const id = await registerRunner("former-host");
  const page = await signedInAt("runners");
  const record = runnerRecord(page, "former-host");
  const remove = { name: `Remove former-host ${id.slice(0, 8)}` };
  await record.getByRole("button", remove).click();
  const dialog = page.getByRole("dialog");
  // Another member removes the Runner before the hub receives this member's confirmation.
  await page.route(`**/runners/${id}`, async (route) => {
    await system.owner().runners.delete({ id });
    await route.continue();
  });
  await dialog.getByRole("button", remove).click();
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(record).toHaveCount(0);
  await expectBrowser(page.getByRole("status").filter({ hasText: "is already gone" })).toHaveText(
    `former-host ${id.slice(0, 8)} is already gone.`,
  );
}, 30_000);

test("in a browser, a new API key is shown once", async () => {
  const page = await signedInAt("api-keys");
  await page.getByRole("button", { name: "Create key" }).click();
  const dialog = page.getByRole("dialog");
  // Permissions are required; a name is optional.
  await dialog.getByRole("button", { name: "Create key" }).click();
  const firstAction = dialog.getByRole("checkbox").first();
  await expectBrowser(firstAction).toBeFocused();
  await expectBrowser(firstAction).toHaveJSProperty(
    "validationMessage",
    "Choose at least one action.",
  );
  await dialog.getByRole("group", { name: "Jobs" }).getByLabel("read").check();
  await dialog.getByRole("group", { name: "Runners" }).getByLabel("read").check();
  await dialog.getByRole("button", { name: "Create key" }).click();
  await expectBrowser(dialog.getByRole("button", { name: "Copy the key" })).toBeFocused();
  const key = (await dialog.getByLabel("The new API key").innerText()).trim();
  // The key holds what was granted.
  const client = system.client({ "x-api-key": key });
  await client.jobs.counts({});
  await client.runners.list();
  const row = page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: "Unnamed", exact: true }) });
  await row.getByText("job: read").waitFor();
  // Closing the dialog forgets it.
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect.poll(() => page.content()).not.toContain(key);

  await page.reload();
  await row.waitFor();
  expect(await page.content()).not.toContain(key);
}, 30_000);

test("a member can correct a refused key name and keep the permissions they chose", async () => {
  const page = await signedInAt("api-keys");
  await page.getByRole("button", { name: "Create key" }).click();
  const dialog = page.getByRole("dialog");
  const name = dialog.getByRole("textbox", { name: "Name" });
  let createRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api-keys")
      createRequests++;
  });
  const corrected = "Monthly operations reporting key";
  const submitted = `${corrected} archive`;
  await name.fill(submitted);
  await dialog.getByRole("group", { name: "Jobs" }).getByLabel("read").check();
  const create = dialog.getByRole("button", { name: "Create key" });
  await create.click();
  await expectBrowser(name).toHaveJSProperty(
    "validationMessage",
    "Use a name of 32 characters or fewer.",
  );
  await expectBrowser(name).toBeFocused();
  await expectBrowser(name).toHaveValue(submitted);

  expect(createRequests).toBe(0);

  await name.fill(corrected);
  await create.click();
  await expectBrowser(dialog.getByRole("heading")).toHaveText(`The new key, ${corrected}`);
  expect(createRequests).toBe(1);
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
  await page.getByRole("button", { name: "Add Runner" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Runner" });
  expect(await dialog.getByLabel("The command to run on the machine").innerText()).toContain(
    "<a registration key>",
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
