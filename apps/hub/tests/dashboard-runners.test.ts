import type { Browser, Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterAll, beforeAll, expect, onTestFinished, test } from "vite-plus/test";
import * as z from "zod/mini";

import { launchDashboardBrowser, signInAt } from "./dashboard-browser.ts";
import { OWNER, protocolClient, startSystem } from "./harness.ts";

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
  await signInAt(system, page, pathname, member, pathname || "jobs");
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
    .getByRole("alertdialog")
    .getByRole("button", { name: /^Revoke old script/ })
    .click();
  await row.waitFor({ state: "detached" });
  await page.getByRole("heading", { name: "No API keys yet" }).waitFor();
  await expectBrowser(
    page.getByRole("status").filter({ hasText: /^old script .* is revoked\.$/ }),
  ).toBeFocused();
  await expect(system.client({ "x-api-key": key }).jobs.counts({})).rejects.toThrow();
}, 30_000);

test("a pending revocation cannot be left, and its refusal shows in the dialog", async () => {
  const { id } = await system.owner().apiKeys.create({
    name: "scheduled job",
    permissions: { job: ["read"] },
  });
  const page = await signedInAt("api-keys");
  // The slow request must announce its own wait in a document clear of the sign-in announcement.
  await page.reload();
  const release = Promise.withResolvers<void>();
  await page.route(`**/api-keys/${id}`, async (route) => {
    await release.promise;
    await route.continue();
  });
  const revoke = { name: /^Revoke scheduled job / };
  await page.getByRole("button", revoke).click();
  const dialog = page.getByRole("alertdialog");
  const confirm = dialog.getByRole("button", revoke);
  try {
    await confirm.click();
    await expectBrowser(dialog.getByText("Working…")).toBeVisible();
    await expectBrowser(confirm).toBeFocused();
    // Screen readers hear it once the request has run for a second.
    await expectBrowser(page.getByRole("status").filter({ hasText: /^Working…$/ })).toBeAttached();
    await page.keyboard.press("Escape");
    await expectBrowser(dialog).toBeVisible();
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
  await expectBrowser(dialog.getByRole("alert")).toHaveText("Unauthorized");
  await expectBrowser(confirm).toBeFocused();
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
  // The slow request must announce its own wait in a document clear of the sign-in announcement.
  await page.reload();
  // If a disabled link navigates, it leaves the dialog for this local stand-in.
  await page.route("https://github.com/elflodge/elflodge/**", (route) =>
    route.fulfill({ contentType: "text/plain", body: "Runner documentation" }),
  );
  const trigger = page.getByRole("button", { name: "Add Runner" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Add Runner" });
  await expectBrowser(dialog).toBeFocused();
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

  const create = dialog.getByRole("button", { name: "Create a registration key" });
  const close = dialog.getByRole("button", { name: "Close" });
  let sent = 0;
  const release = Promise.withResolvers<void>();
  await page.route(
    (url) => url.pathname === "/api-keys",
    async (route) => {
      if (route.request().method() === "POST") {
        sent++;
        await release.promise;
      }
      await route.fallback();
    },
  );
  try {
    await create.press("Enter");
    await expectBrowser(create).toBeFocused();
    await expectBrowser(create).toHaveAttribute("aria-busy", "true");
    await expectBrowser(close).toBeDisabled();
    for (const name of ["Runners on other machines", "the Runner's README"]) {
      const link = dialog.getByRole("link", { name });
      await expectBrowser(link).toHaveAttribute("aria-disabled", "true");
      await expectBrowser(link).toHaveJSProperty("tabIndex", -1);
      await link.click({ force: true });
      await link.press("Enter");
      await expectBrowser(dialog).toBeVisible();
    }
    await create.focus();
    await expectBrowser(page.getByRole("status").filter({ hasText: /^Working…$/ })).toHaveCount(1);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await close.focus();
    await expectBrowser(close).toBeFocused();
    await page.keyboard.press("Enter");
    await page.mouse.click(1, 1);
    await expectBrowser(dialog).toBeVisible();
  } finally {
    release.resolve();
  }

  await dialog.getByText("Shown this once:").waitFor();
  const copy = dialog.getByRole("button", { name: "Copy the command" });
  await expectBrowser(copy).toBeFocused();
  await expectBrowser(copy).toHaveAccessibleDescription(/^Shown this once: the registration key/);
  expect(sent).toBe(1);
  const key = await command.locator("mark.key").innerText();
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], { origin: system.origin });
  await copy.click();
  await expectBrowser(dialog.getByRole("status").filter({ hasText: /^Copied\.$/ })).toHaveCount(1);
  const copied = await page.evaluate<string>("navigator.clipboard.readText()");
  expect(copied === (await command.textContent())).toBe(true);
  const live = page.locator(
    '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"], output',
  );
  expect((await live.allTextContents()).some((message) => message.includes(key))).toBe(false);
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
  await close.click();
  await expectBrowser(trigger).toBeFocused();
  expect(await page.content()).not.toContain(key);
  await trigger.click();
  await expectBrowser(command).toContainText("<a registration key>");
  expect(await page.content()).not.toContain(key);
  await expectBrowser(
    dialog.getByRole("status").filter({ hasText: "Waiting for a Runner" }),
  ).toBeVisible();
}, 30_000);

test("Add Runner keeps one key request and its refusal across changes of role", async () => {
  await registerRunner("role-check-host");
  const reader = {
    name: "Key manager",
    email: "key-manager@example.com",
    password: "a long enough password",
  };
  const { userId } = await system.addMember(reader);
  const org = system.ownerAuth().organization;
  const [organization] = await org.list();
  if (!organization) throw new Error("The hub has no Organization");
  const { members } = await org.listMembers({ query: { organizationId: organization.id } });
  const member = members.find((item) => item.userId === userId);
  if (!member) throw new Error("The reader has no membership");
  const setRole = (role: "admin" | "member") =>
    org.updateMemberRole({
      organizationId: organization.id,
      memberId: member.id,
      role,
    });
  await setRole("admin");
  const page = await signedInAt("runners", reader);
  const remove = page.getByRole("button", {
    name: /^Remove role-check-host /,
    includeHidden: true,
  });
  async function readRole(role: "admin" | "member") {
    await setRole(role);
    // Navigating within this page reads the session again and keeps the dialog mounted.
    await page.evaluate('history.replaceState(history.state, "", location.href)');
    await expectBrowser(remove).toHaveCount(role === "admin" ? 1 : 0);
  }

  await page.getByRole("button", { name: "Add Runner" }).click();
  const dialog = page.getByRole("dialog");
  const create = dialog.getByRole("button", { name: "Create a registration key" });
  const close = dialog.getByRole("button", { name: "Close" });
  let writes = 0;
  const release = Promise.withResolvers<void>();
  onTestFinished(() => release.resolve());
  await page.route(
    (url) => url.pathname === "/api-keys",
    async (route) => {
      if (route.request().method() === "POST") {
        writes++;
        await release.promise;
      }
      await route.continue();
    },
  );
  await create.click();
  await readRole("member");
  await expectBrowser(create).toBeFocused();
  await expectBrowser(dialog.getByText("Working…")).toBeVisible();
  await readRole("admin");
  await create.press("Enter");
  await readRole("member");
  await page.keyboard.press("Escape");
  await expectBrowser(close).toBeDisabled();
  const answer = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api-keys" && r.request().method() === "POST",
  );
  release.resolve();
  const refusal = await answer;
  expect(refusal.status()).toBe(403);
  const { detail } = z.object({ detail: z.string() }).parse(await refusal.json());
  await expectBrowser(dialog.getByRole("alert")).toHaveText(detail);
  await expectBrowser(create).toBeFocused();
  await expectBrowser(create).toBeDisabled();
  await expectBrowser(close).toBeEnabled();
  expect(writes).toBe(1);

  // On retry the hub creates a key before the demotion, but delivers it afterwards.
  await readRole("admin");
  const created = Promise.withResolvers<void>();
  const deliver = Promise.withResolvers<void>();
  onTestFinished(() => deliver.resolve());
  await page.route(
    (url) => url.pathname === "/api-keys",
    async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const response = await route.fetch({ url: new URL("/api-keys", system.url()).href });
      created.resolve();
      await deliver.promise;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await create.click();
  await created.promise;
  await expectBrowser(dialog.getByRole("alert")).toHaveCount(0);
  await readRole("member");
  deliver.resolve();
  await expectBrowser(dialog.getByRole("button", { name: "Copy the command" })).toBeFocused();
  await expectBrowser(dialog.locator("mark.key")).toHaveText(/\S+/);
}, 30_000);

test("in a browser, removing a Runner takes it off the list", async () => {
  const id = await registerRunner("retired-host");
  const page = await signedInAt("runners");
  const record = runnerRecord(page, "retired-host");
  await record.getByRole("button", { name: /^Remove / }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: `Remove retired-host ${id.slice(0, 8)}` })
    .click();
  await record.waitFor({ state: "detached" });
  await expectBrowser(page.getByRole("status").filter({ hasText: "is removed" })).toBeFocused();
  expect(await system.findRunner(id)).toBeUndefined();
}, 30_000);

test("removing an already removed Runner closes the dialog and explains its absence", async () => {
  const id = await registerRunner("former-host");
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  await page.clock.install();
  await signInAt(system, page, "runners", OWNER);
  const record = runnerRecord(page, "former-host");
  const remove = { name: `Remove former-host ${id.slice(0, 8)}` };
  await record.getByRole("button", remove).click();
  const dialog = page.getByRole("alertdialog");
  // Another member removes the Runner before the hub receives this member's confirmation.
  let refused = false;
  await page.route(`**/runners/${id}`, async (route) => {
    await system.owner().runners.delete({ id });
    refused = true;
    await route.continue();
  });
  // The read that finds it gone waits until a poll is under way; that poll and every later read of
  // the list are held, so the row goes with the notice and not with a later read.
  let reads = 0;
  const checking = Promise.withResolvers<void>();
  const polling = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  onTestFinished(() => release.resolve());
  await page.route(
    (url) => url.pathname.endsWith("/runners"),
    async (route) => {
      if (refused) {
        reads += 1;
        if (reads === 1) {
          checking.resolve();
          await polling.promise;
        } else {
          polling.resolve();
          await release.promise;
        }
      }
      await route.continue();
    },
  );
  // No poll comes between the removal and the read that checks it.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  await dialog.getByRole("button", remove).click();
  await checking.promise;
  // The page reads the list every five seconds.
  await page.clock.runFor(5_000);
  await polling.promise;
  await page.clock.resume();
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(record).toHaveCount(0);
  await expectBrowser(page.getByRole("status").filter({ hasText: "is already gone" })).toHaveText(
    `former-host ${id.slice(0, 8)} is already gone.`,
  );
}, 30_000);

test("an already-gone check keeps a Runner that a later read added while it ran", async () => {
  const id = await registerRunner("checked-host");
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  await page.clock.install();
  await signInAt(system, page, "runners", OWNER);
  const remove = { name: `Remove checked-host ${id.slice(0, 8)}` };
  await runnerRecord(page, "checked-host").getByRole("button", remove).click();
  const dialog = page.getByRole("alertdialog");
  let refused = false;
  await page.route(`**/runners/${id}`, async (route) => {
    await system.owner().runners.delete({ id });
    refused = true;
    await route.continue();
  });
  // The check's answer is read at once and delivered once a later read has shown a new Runner.
  // Reads after that one are held, so none can restore a Runner the check wrongly discarded.
  let reads = 0;
  const checking = Promise.withResolvers<void>();
  const shown = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  onTestFinished(() => release.resolve());
  await page.route(
    (url) => url.pathname.endsWith("/runners"),
    async (route) => {
      if (refused && ++reads === 1) {
        // Playwright fetches outside the browser, which maps the hub's host to the test hub.
        const url = new URL(route.request().url());
        const response = await route.fetch({
          url: new URL(url.pathname + url.search, system.url()).href,
          headers: { ...route.request().headers(), host: url.host },
        });
        checking.resolve();
        await shown.promise;
        await route.fulfill({ response });
        return;
      }
      if (refused && reads > 2) await release.promise;
      await route.continue();
    },
  );
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  await dialog.getByRole("button", remove).click();
  await checking.promise;
  await registerRunner("later-host");
  // The page reads the list every five seconds.
  await page.clock.runFor(5_000);
  await runnerRecord(page, "later-host").waitFor();
  shown.resolve();
  await page.clock.resume();
  await expectBrowser(page.getByRole("status").filter({ hasText: "is already gone" })).toHaveText(
    `checked-host ${id.slice(0, 8)} is already gone.`,
  );
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(runnerRecord(page, "later-host")).toBeVisible();
}, 30_000);

test("a removal the hub fails with a 500 says it could not be confirmed", async () => {
  const id = await registerRunner("failing-host");
  const page = await signedInAt("runners");
  await page.route(
    `**/runners/${id}`,
    (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/problem+json",
        json: { type: "about:blank", title: "Internal Server Error", status: 500, detail: "boom" },
      }),
    { times: 1 },
  );
  const remove = { name: `Remove failing-host ${id.slice(0, 8)}` };
  await runnerRecord(page, "failing-host").getByRole("button", remove).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", remove).click();
  await expectBrowser(dialog.getByRole("alert")).toHaveText(
    "The dashboard could not confirm this was done. Check before trying again.",
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
  const copy = dialog.getByRole("button", { name: "Copy the key" });
  await expectBrowser(copy).toBeFocused();
  // The new heading is not announced while focus is in the dialog; the button's description says it.
  await expectBrowser(copy).toHaveAccessibleDescription(/^Shown this once: copy it now\./);
  const key = (await dialog.getByLabel("The new API key").innerText()).trim();
  // The key holds what was granted.
  const client = system.client({ "x-api-key": key });
  await client.jobs.counts({});
  await client.runners.list();
  const row = page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: "Unnamed", exact: true }) });
  await row.getByText("job: read").waitFor();
  // Closing the dialog forgets it: opened again, it asks afresh.
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect.poll(() => page.content()).not.toContain(key);
  await page.getByRole("button", { name: "Create key" }).click();
  await expectBrowser(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("");
  await expectBrowser(dialog.getByRole("heading")).toHaveText("Create an API key");
  expect(await page.content()).not.toContain(key);
  await page.keyboard.press("Escape");

  await page.reload();
  await row.waitFor();
  expect(await page.content()).not.toContain(key);
}, 30_000);

test("Create key cannot be left while the hub answers, and then shows the key with Copy focused", async () => {
  const page = await signedInAt("api-keys");
  await page.getByRole("button", { name: "Create key" }).click();
  const dialog = page.getByRole("dialog");
  const name = dialog.getByRole("textbox", { name: "Name" });
  await name.fill("held key");
  await dialog.getByRole("group", { name: "Jobs" }).getByLabel("read").check();
  let sent = 0;
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const reread = Promise.withResolvers<void>();
  const releaseReread = Promise.withResolvers<void>();
  await page.route(
    (url) => url.pathname === "/api-keys",
    async (route) => {
      if (route.request().method() !== "POST") {
        reread.resolve();
        await releaseReread.promise;
        return route.fallback();
      }
      sent++;
      arrived.resolve();
      await release.promise;
      await route.fallback();
    },
  );
  const create = dialog.getByRole("button", { name: "Create key" });
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  const held = await dialog.elementHandle();
  try {
    await create.press("Enter");
    await arrived.promise;
    await expectBrowser(dialog.getByText("Working…")).toBeVisible();
    await expectBrowser(create).toHaveAttribute("aria-disabled", "true");
    await expectBrowser(cancel).toHaveAttribute("aria-disabled", "true");
    await expectBrowser(name).toHaveJSProperty("readOnly", true);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    await expectBrowser(create).toBeFocused();
    await cancel.click({ force: true });
    await name.press("Enter");
  } finally {
    release.resolve();
  }
  // Still the same dialog: the answer shows in it, without waiting for the list's reread.
  try {
    await reread.promise;
    await expectBrowser(dialog.getByRole("button", { name: "Copy the key" })).toBeFocused();
    await expectBrowser(dialog.getByRole("heading")).toHaveText("The new key, held key");
    expect(await held.evaluate((element) => element.isConnected)).toBe(true);
  } finally {
    releaseReread.resolve();
  }
  expect(sent).toBe(1);
  // Once the hub has answered, Escape closes it.
  await page.keyboard.press("Escape");
  await expectBrowser(dialog).toBeHidden();
}, 30_000);

test.each(["Create key", "Add Runner"] as const)(
  "%s reports a malformed key answer as uncertain and keeps the key out of the console",
  async (task) => {
    const page = await signedInAt(task === "Add Runner" ? "runners" : "api-keys");
    await page.getByRole("button", { name: task }).click();
    const dialog = page.getByRole("dialog");
    if (task === "Create key") {
      await dialog.getByRole("textbox", { name: "Name" }).fill("unconfirmed");
      await dialog.getByRole("group", { name: "Jobs" }).getByLabel("read").check();
    }
    // The hub creates the key; its answer reaches the page without the key's ID.
    let key = "";
    await page.route(
      (url) => url.pathname === "/api-keys",
      async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        // Sent by the test to the hub's own address, which the browser reaches by its host name.
        const response = await route.fetch({
          url: route.request().url().replace(system.origin, system.url().origin),
        });
        ({ key } = z.object({ key: z.string() }).parse(await response.json()));
        await route.fulfill({ response, json: { key } });
      },
    );
    await page.clearConsoleMessages();
    await dialog
      .getByRole("button", { name: task === "Create key" ? task : "Create a registration key" })
      .click();
    await expectBrowser(dialog.getByRole("alert")).toHaveText(
      "The dashboard could not confirm this was done. Check before trying again.",
    );
    if (task === "Create key") {
      await expectBrowser(page.locator("tbody tr", { hasText: "unconfirmed" })).toHaveCount(1);
    }
    expect(key).not.toBe("");
    const messages = await page.consoleMessages();
    expect(messages.filter((message) => message.type() === "error")).toHaveLength(1);
    const loggedKey = await page.evaluate(
      ({ args, secret }) => {
        const seen = new Set<object>();
        const holdsKey = (value: unknown): boolean => {
          if (typeof value === "string") return value.includes(secret);
          if (typeof value !== "object" || value === null || seen.has(value)) return false;
          seen.add(value);
          // Error.message, stack and cause can all be non-enumerable.
          return Reflect.ownKeys(value).some(
            (name) => String(name).includes(secret) || holdsKey(Reflect.get(value, name)),
          );
        };
        return args.some(holdsKey);
      },
      { args: messages.flatMap((message) => message.args()), secret: key },
    );
    expect(loggedKey).toBe(false);
  },
  30_000,
);
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
    "Use a name of 32 characters or fewer. This one has 40.",
  );
  await expectBrowser(name).toBeFocused();
  await expectBrowser(name).toHaveValue(submitted);

  expect(createRequests).toBe(0);
  await create.evaluate((button) => button.setAttribute("formnovalidate", ""));
  await create.click();
  await expectBrowser(name).toHaveAttribute("aria-invalid", "true");
  await expectBrowser(name).toBeFocused();
  await expectBrowser(dialog.getByRole("alert")).toHaveCount(0);

  // An edit of the refused field ends its words.
  await name.fill(corrected);
  await expectBrowser(name).not.toHaveAttribute("aria-invalid", "true");
  await page.route(
    (url) => url.pathname === "/api-keys",
    (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/problem+json",
        json: {
          type: "about:blank",
          title: "Bad Request",
          status: 400,
          errors: [{ pointer: "/permissions/job/0", detail: "Choose another action" }],
        },
      }),
    { times: 1 },
  );
  await create.click();
  const permissions = dialog.getByRole("group", { name: "Permissions", exact: true });
  await expectBrowser(permissions).toHaveAccessibleDescription(/Choose another action/);
  await expectBrowser(permissions).toBeFocused();
  await expectBrowser(dialog.getByRole("alert")).toHaveCount(0);
  await create.click();
  await expectBrowser(dialog.getByRole("heading")).toHaveText(`The new key, ${corrected}`);
  expect(createRequests).toBe(3);
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

test("a revoked key's notice has focus before the list is read again, and if that read fails", async () => {
  await system.owner().apiKeys.create({ name: "held list key", permissions: { job: ["read"] } });
  const page = await signedInAt("api-keys");
  const revoke = { name: /^Revoke held list key/ };
  await page.getByRole("button", revoke).click();
  const reread = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route(
    (url) => url.pathname.endsWith("/api-keys"),
    async (route) => {
      reread.resolve();
      await release.promise;
      await route.abort("failed");
    },
  );
  const notice = page.getByRole("status").filter({ hasText: /held list key .* is revoked\./ });
  try {
    await page.getByRole("alertdialog").getByRole("button", revoke).click();
    await reread.promise;
    await expectBrowser(page.getByRole("alertdialog")).toBeHidden();
    await expectBrowser(notice).toBeFocused();
  } finally {
    release.resolve();
  }
  // Query tries the read again before it reports the failure.
  await expectBrowser(page.getByText("The API keys could not be read")).toBeVisible({
    timeout: 15_000,
  });
  await expectBrowser(notice).toBeFocused();
}, 30_000);

test("keeping a key returns focus to its Revoke, while an earlier key's notice is shown", async () => {
  await system.owner().apiKeys.create({ name: "kept key a", permissions: { job: ["read"] } });
  await system.owner().apiKeys.create({ name: "kept key b", permissions: { job: ["read"] } });
  const page = await signedInAt("api-keys");
  const dialog = page.getByRole("alertdialog");
  const revokeA = { name: /^Revoke kept key a/ };
  await page.getByRole("button", revokeA).click();
  await dialog.getByRole("button", revokeA).click();
  await expectBrowser(page.getByRole("status").filter({ hasText: /kept key a/ })).toBeFocused();
  const revokeB = page.getByRole("button", { name: /^Revoke kept key b/ });
  await revokeB.click();
  await dialog.getByRole("button", { name: "Keep it" }).click();
  await expectBrowser(revokeB).toBeFocused();
  await revokeB.press("Enter");
  await expectBrowser(dialog.getByRole("button", { name: "Keep it" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expectBrowser(revokeB).toBeFocused();
}, 30_000);

test("a revocation the hub never answers ends on its own after 30 seconds, saying it may have been done", async () => {
  const { id } = await system.owner().apiKeys.create({
    name: "unanswered key",
    permissions: { job: ["read"] },
  });
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  await page.clock.install();
  await signInAt(system, page, "api-keys", OWNER);
  const revoke = { name: /^Revoke unanswered key/ };
  await page.getByRole("button", revoke).click();
  const dialog = page.getByRole("alertdialog");
  const arrived = Promise.withResolvers<void>();
  await page.route(`**/api-keys/${id}`, () => arrived.resolve());
  // Nor does it answer the reads of the list the failure starts.
  await page.route(
    (url) => url.pathname.endsWith("/api-keys"),
    () => {},
  );
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  await dialog.getByRole("button", revoke).click();
  await arrived.promise;
  await page.clock.runFor(29_999);
  await expectBrowser(dialog.getByText("Working…")).toBeVisible();
  await expectBrowser(dialog.getByRole("alert")).toHaveCount(0);
  await page.clock.runFor(1);
  await expectBrowser(dialog.getByRole("alert")).toHaveText(
    "The dashboard could not confirm this was done. Check before trying again.",
  );
  await expectBrowser(dialog.getByText("Working…")).toHaveCount(0);
  await page.clock.resume();
  await page.keyboard.press("Escape");
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(page.getByRole("button", revoke)).toBeFocused();
}, 30_000);

test("a refusal decided after a reread shows in the open dialog, with focus on its button", async () => {
  const id = await registerRunner("refused-host");
  const page = await signedInAt("runners");
  const record = runnerRecord(page, "refused-host");
  const remove = { name: `Remove refused-host ${id.slice(0, 8)}` };
  await record.getByRole("button", remove).click();
  const dialog = page.getByRole("alertdialog");
  let refused = false;
  let sent = 0;
  page.on("request", (request) => {
    if (request.method() === "DELETE" && request.url().endsWith(`/runners/${id}`)) sent += 1;
  });
  const reread = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route(
    `**/runners/${id}`,
    async (route) => {
      refused = true;
      await route.fulfill({
        status: 404,
        contentType: "application/problem+json",
        json: {
          type: "about:blank",
          title: "Not Found",
          status: 404,
          detail: "No such Runner here.",
        },
      });
    },
    { times: 1 },
  );
  // Every read of the list after the refusal, so a poll cannot take the place of the reread.
  await page.route(
    (url) => url.pathname.endsWith("/runners"),
    async (route) => {
      if (refused) {
        reread.resolve();
        await release.promise;
      }
      await route.continue();
    },
  );
  const confirm = dialog.getByRole("button", remove);
  try {
    await confirm.click();
    await reread.promise;
    await expectBrowser(dialog.getByText("Working…")).toBeVisible();
    await expectBrowser(confirm).toBeDisabled();
  } finally {
    release.resolve();
  }
  await expectBrowser(dialog.getByRole("alert")).toHaveText("No such Runner here.");
  await expectBrowser(dialog.getByText("Working…")).toHaveCount(0);
  await expectBrowser(confirm).toBeEnabled();
  await expectBrowser(confirm).toBeFocused();
  // Trying again sends the removal again.
  await confirm.click();
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(page.getByRole("status").filter({ hasText: "is removed" })).toBeFocused();
  expect(sent).toBe(2);
  expect(await system.findRunner(id)).toBeUndefined();
}, 30_000);

test("a confirmed revocation is sent once, however often it is pressed", async () => {
  const { id } = await system
    .owner()
    .apiKeys.create({ name: "pressed key", permissions: { job: ["read"] } });
  const page = await signedInAt("api-keys");
  let sent = 0;
  const release = Promise.withResolvers<void>();
  await page.route(`**/api-keys/${id}`, async (route) => {
    sent += 1;
    await release.promise;
    await route.continue();
  });
  const dialog = page.getByRole("alertdialog");
  const revoke = { name: /^Revoke pressed key/ };
  await page.getByRole("button", revoke).click();
  const confirm = dialog.getByRole("button", revoke);
  try {
    await confirm.click();
    await expectBrowser(dialog.getByText("Working…")).toBeVisible();
    await confirm.click({ force: true });
    await confirm.press("Enter");
    // Nor can the safe choice leave it while the request runs, and it says so.
    const keep = dialog.getByRole("button", { name: "Keep it" });
    await expectBrowser(keep).toHaveAttribute("aria-disabled", "true");
    await expectBrowser(keep).toHaveAttribute("data-disabled", "");
    await keep.click({ force: true });
    await expectBrowser(dialog).toBeVisible();
  } finally {
    release.resolve();
  }
  await expectBrowser(page.getByRole("row").filter({ hasText: "pressed key" })).toHaveCount(0);
  expect(sent).toBe(1);
}, 30_000);

test("a removal confirmed while the list is being read shows its progress and ends on its notice", async () => {
  const id = await registerRunner("polled-host");
  const page = await signedInAt("runners");
  const remove = { name: `Remove polled-host ${id.slice(0, 8)}` };
  await runnerRecord(page, "polled-host").getByRole("button", remove).click();
  const reading = Promise.withResolvers<void>();
  const releaseRead = Promise.withResolvers<void>();
  await page.route(
    (url) => url.pathname.endsWith("/runners"),
    async (route) => {
      reading.resolve();
      await releaseRead.promise;
      await route.continue();
    },
  );
  const releaseRemoval = Promise.withResolvers<void>();
  await page.route(`**/runners/${id}`, async (route) => {
    await releaseRemoval.promise;
    await route.continue();
  });
  const dialog = page.getByRole("alertdialog");
  try {
    // The page reads the list again every few seconds.
    await reading.promise;
    await dialog.getByRole("button", remove).click();
    await expectBrowser(dialog.getByText("Working…")).toBeVisible();
    releaseRemoval.resolve();
    await expectBrowser(dialog).toHaveCount(0);
    await expectBrowser(page.getByRole("status").filter({ hasText: "is removed" })).toBeFocused();
  } finally {
    releaseRemoval.resolve();
    releaseRead.resolve();
  }
}, 30_000);

test("a second revocation while the first one's reread is unanswered shows its progress and ends on its notice", async () => {
  const first = await system
    .owner()
    .apiKeys.create({ name: "first held key", permissions: { job: ["read"] } });
  const second = await system
    .owner()
    .apiKeys.create({ name: "second held key", permissions: { job: ["read"] } });
  const page = await signedInAt("api-keys");
  const dialog = page.getByRole("alertdialog");
  // Every read of the list from the first revocation on.
  let revoked = false;
  const reread = Promise.withResolvers<void>();
  const releaseRead = Promise.withResolvers<void>();
  await page.route(
    (url) => url.pathname.endsWith("/api-keys"),
    async (route) => {
      if (revoked) {
        reread.resolve();
        await releaseRead.promise;
      }
      await route.continue();
    },
  );
  await page.route(`**/api-keys/${first.id}`, async (route) => {
    revoked = true;
    await route.continue();
  });
  const releaseRevocation = Promise.withResolvers<void>();
  await page.route(`**/api-keys/${second.id}`, async (route) => {
    await releaseRevocation.promise;
    await route.continue();
  });
  try {
    const revokeFirst = { name: /^Revoke first held key/ };
    await page.getByRole("button", revokeFirst).click();
    await dialog.getByRole("button", revokeFirst).click();
    await expectBrowser(
      page.getByRole("status").filter({ hasText: /first held key .* is revoked/ }),
    ).toBeFocused();
    await reread.promise;
    const revokeSecond = { name: /^Revoke second held key/ };
    await page.getByRole("button", revokeSecond).click();
    await dialog.getByRole("button", revokeSecond).click();
    await expectBrowser(dialog.getByText("Working…")).toBeVisible();
    releaseRevocation.resolve();
    await expectBrowser(dialog).toHaveCount(0);
    await expectBrowser(
      page.getByRole("status").filter({ hasText: /second held key .* is revoked/ }),
    ).toBeFocused();
  } finally {
    releaseRevocation.resolve();
    releaseRead.resolve();
  }
}, 30_000);

test("an already removed Runner whose list the hub does not answer ends after 30 seconds on the hub's refusal", async () => {
  const id = await registerRunner("unchecked-host");
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  await page.clock.install();
  await signInAt(system, page, "runners", OWNER);
  const remove = { name: `Remove unchecked-host ${id.slice(0, 8)}` };
  await runnerRecord(page, "unchecked-host").getByRole("button", remove).click();
  const dialog = page.getByRole("alertdialog");
  let refused = false;
  await page.route(`**/runners/${id}`, async (route) => {
    refused = true;
    await route.fulfill({
      status: 404,
      contentType: "application/problem+json",
      json: {
        type: "about:blank",
        title: "Not Found",
        status: 404,
        detail: "No such Runner here.",
      },
    });
  });
  // No read of the list after the refusal is answered.
  const checking = Promise.withResolvers<void>();
  await page.route(
    (url) => url.pathname.endsWith("/runners"),
    async (route) => {
      if (!refused) return route.continue();
      checking.resolve();
    },
  );
  await dialog.getByRole("button", remove).click();
  await checking.promise;
  await expectBrowser(dialog.getByText("Working…")).toBeVisible();
  await page.clock.fastForward(30_000);
  await expectBrowser(dialog.getByRole("alert")).toHaveText("No such Runner here.");
  await page.keyboard.press("Escape");
  await expectBrowser(dialog).toHaveCount(0);
}, 30_000);

test("removing a Runner far down a long list brings its notice into view", async () => {
  for (const name of ["tall-a", "tall-b", "tall-c", "tall-d"]) await registerRunner(name);
  const page = await signedInAt("runners");
  await page.setViewportSize({ width: 800, height: 500 });
  const button = page
    .locator("ul.runners > li")
    .last()
    .getByRole("button", { name: /^Remove / });
  const remove = { name: (await button.getAttribute("aria-label")) ?? "" };
  await button.scrollIntoViewIfNeeded();
  await expectBrowser(
    page.getByRole("heading", { name: "Runners", level: 1 }),
  ).not.toBeInViewport();
  await button.click();
  await page.getByRole("alertdialog").getByRole("button", remove).click();
  const removed = page.getByRole("status").filter({ hasText: / is removed\./ });
  await expectBrowser(removed).toBeFocused();
  await expectBrowser(removed).toBeInViewport();
}, 30_000);

test("a Runner a read drops while its dialog is open is still named there, and is already gone", async () => {
  const id = await registerRunner("dropped-host");
  const page = await signedInAt("runners");
  const record = runnerRecord(page, "dropped-host");
  await record.getByRole("button", { name: /^Remove / }).click();
  const dialog = page.getByRole("alertdialog");
  const heading = `Remove dropped-host ${id.slice(0, 8)}?`;
  await expectBrowser(dialog.getByRole("heading")).toHaveText(heading);
  await system.owner().runners.delete({ id });
  // The page reads the list again every few seconds.
  await record.waitFor({ state: "detached", timeout: 15_000 });
  await expectBrowser(dialog.getByRole("heading")).toHaveText(heading);
  await dialog.getByRole("button", { name: `Remove dropped-host ${id.slice(0, 8)}` }).click();
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(
    page.getByRole("status").filter({ hasText: "is already gone" }),
  ).toBeFocused();
}, 30_000);

test("a newly listed key cannot take over a pending revocation", async () => {
  await system.owner().apiKeys.create({ name: "earlier key", permissions: { job: ["read"] } });
  const first = await system
    .owner()
    .apiKeys.create({ name: "original revocation", permissions: { job: ["read"] } });
  const page = await signedInAt("api-keys");
  const dialog = page.getByRole("alertdialog");
  const earlierRevoke = { name: /^Revoke earlier key / };
  await page.getByRole("button", earlierRevoke).click();
  await dialog.getByRole("button", earlierRevoke).click();
  await expectBrowser(page.getByRole("status").filter({ hasText: "is revoked" })).toBeFocused();
  const revoke = { name: /^Revoke original revocation / };
  await page.getByRole("button", revoke).click();
  const heading = await dialog.getByRole("heading").innerText();
  const release = Promise.withResolvers<void>();
  onTestFinished(() => release.resolve());
  await page.route(`**/api-keys/${first.id}`, async (route) => {
    await release.promise;
    await route.fulfill({
      status: 409,
      contentType: "application/problem+json",
      json: { type: "about:blank", title: "Conflict", status: 409, detail: "The key is in use." },
    });
  });
  await dialog.getByRole("button", revoke).click();
  await expectBrowser(dialog.getByText("Working…")).toBeVisible();

  // Two reads after returning to the tab, first an empty list, then the newly created key.
  async function readAgain() {
    await page.clock.setFixedTime(new Date((await page.evaluate(() => Date.now())) + 5_000));
    await page.evaluate('window.dispatchEvent(new Event("visibilitychange"))');
  }
  await page.route(
    (url) => url.pathname === "/api-keys",
    (route) => route.fulfill({ json: [] }),
    { times: 1 },
  );
  await readAgain();
  await page.getByRole("heading", { name: "No API keys yet" }).waitFor();
  await system.owner().apiKeys.create({ name: "arriving key", permissions: { job: ["read"] } });
  await readAgain();
  await page.getByRole("button", { name: /^Revoke arriving key / }).click();
  await expectBrowser(dialog.getByRole("heading")).toHaveText(heading);
  await expectBrowser(dialog.getByText("Working…")).toBeVisible();
  release.resolve();
  await expectBrowser(dialog.getByRole("alert")).toHaveText("The key is in use.");
  await expectBrowser(dialog.getByRole("heading")).toHaveText(heading);
}, 30_000);

test("a Runner that registers beside an earlier notice stays behind Add Runner", async () => {
  const first = await registerRunner("retired");
  const page = await signedInAt("runners");
  await runnerRecord(page, "retired")
    .getByRole("button", { name: /^Remove / })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: `Remove retired ${first.slice(0, 8)}` })
    .click();
  await expectBrowser(page.getByRole("status").filter({ hasText: "is removed" })).toBeFocused();
  for (const runner of await system.owner().runners.list()) {
    await system.owner().runners.delete({ id: runner.id });
  }
  await page.getByRole("heading", { name: "No Runners yet" }).waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "Add Runner" }).click();
  const dialog = page.getByRole("dialog");
  const { runnerId: id, socket } = await system.connectRunner();
  onTestFinished(() => socket.close(1000));
  await expectBrowser(dialog.getByRole("status").filter({ hasText: "has registered." })).toHaveText(
    `test runner ${id.slice(0, 8)} has registered.`,
    { timeout: 15_000 },
  );
  const note = page.getByText(/Connected means the hub has heard/);
  expect(await note.evaluate((p) => p.closest("[inert]") !== null)).toBe(true);
  const sentence = await dialog
    .getByText(`test runner ${id.slice(0, 8)} has registered.`)
    .elementHandle();
  const contact = page.locator(`li[id="${id}"] time`).first();
  const before = await contact.getAttribute("datetime");
  if (!before) throw new Error("The Runner has no last contact");
  await protocolClient(socket).request("sync", { held: [], free: 0 }, 10_000);
  await expectBrowser(contact).not.toHaveAttribute("datetime", before, { timeout: 15_000 });
  expect(await sentence.evaluate((el) => el.isConnected)).toBe(true);
  const remove = page.getByRole("button", { name: /^Remove test runner /, includeHidden: true });
  expect(await remove.evaluate((button) => button.closest("[inert]") !== null)).toBe(true);
  await page.keyboard.press("Escape");
  await expectBrowser(dialog).toBeHidden();
  await remove.focus();
  await expectBrowser(remove).toBeFocused();
}, 60_000);
