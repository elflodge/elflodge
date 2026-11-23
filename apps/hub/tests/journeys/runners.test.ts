import type { Browser, Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterAll, beforeAll, expect, onTestFinished, test } from "vite-plus/test";

import { launchDashboardBrowser, liveRegions, signInAt } from "../dashboard-browser.ts";
import { OWNER, startSystem } from "../harness.ts";

// What the hub takes from the Runners and API keys pages: the keys they create work for what they
// were created for.

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

/**
 * Opens the dashboard's `pathname` in a new page, signed out, and signs in there as the owner, to
 * land on `landing`. The page's clock is installed first, so a test can move it to a poll.
 */
async function signedInAt(pathname: string, landing = pathname): Promise<Page> {
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  await page.clock.install();
  await signInAt(system, page, pathname, OWNER, landing);
  return page;
}

test("a registration key Add Runner creates when asked registers a Runner, which the dialog and the page then show", async () => {
  const before = await system.owner().apiKeys.list();
  const page = await signedInAt("", "jobs");
  // The strip's count of Runners leads to their page.
  await page
    .getByRole("region", { name: "The hub now" })
    .getByRole("link", { name: /Runners/ })
    .click();
  await page.waitForURL(`${system.origin}/dashboard/runners`);
  const trigger = page.getByRole("button", { name: "Add Runner" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Add Runner" });
  await expectBrowser(dialog).toBeFocused();
  const command = dialog.getByLabel("The command to run on the machine");
  await expectBrowser(
    dialog.getByText("Waiting for a Runner to register.", { exact: false }),
  ).toBeVisible();
  const text = await command.innerText();
  expect(text).toContain("<a registration key>");
  expect(text).toContain("HUB_URL=<the hub's URL from that machine>");
  expect(text).not.toContain(system.origin);
  // Opening it created nothing.
  expect(await system.owner().apiKeys.list()).toHaveLength(before.length);

  await dialog.getByRole("button", { name: "Create a registration key" }).click();
  await dialog.getByText("Shown this once:").waitFor();
  const copyLine = dialog.locator("p.copy");
  const copy = copyLine.getByRole("button", { name: "Copy the command" });
  await expectBrowser(copy).toBeFocused();
  await expectBrowser(copy).toHaveAccessibleDescription(/^Shown this once: the registration key/);
  const key = await command.locator("mark.key").innerText();

  // Copying says so through UI SDK's live region, outside the dialog and never inert, and the
  // announcements never carry the key.
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], { origin: system.origin });
  await copy.click();
  await expectBrowser(copyLine.getByText("Copied.", { exact: true })).toBeVisible();
  const live = liveRegions(page);
  const result = live.filter({ hasText: "Copied." });
  await expectBrowser(result).toHaveCount(1);
  await expectBrowser(result).toHaveText("Copied.");
  await expectBrowser(result.and(dialog.locator("*"))).toHaveCount(0);
  await expectBrowser(result).toHaveRole("status");
  await expectBrowser(result).toHaveAttribute("aria-live", "polite");
  expect(await result.evaluate((element) => element.closest("[inert]") === null)).toBe(true);
  const copied = await page.evaluate<string>("navigator.clipboard.readText()");
  expect(copied === (await command.textContent())).toBe(true);
  expect((await live.allTextContents()).some((message) => message.includes(key))).toBe(false);

  // The key in the command registers a Runner, and is an ordinary key, listed with the others.
  const { id } = await system.runnerClient({ "x-api-key": key }).register({ name: "new-host" });
  // The dialog reads the Runners every five seconds.
  await page.clock.fastForward(5_000);
  await expectBrowser(dialog.getByRole("status").filter({ hasText: "has registered." })).toHaveText(
    `new-host ${id.slice(0, 8)} has registered.`,
  );
  const created = (await system.owner().apiKeys.list()).filter(
    (listed) => !before.some((earlier) => earlier.id === listed.id),
  );
  expect(created).toEqual([
    expect.objectContaining({ permissions: { runner: ["register"] }, expiresAt: expect.any(Date) }),
  ]);

  // Closing it forgets the key, and the page lists the Runner by its name and short ID, since host
  // names repeat.
  await dialog.getByRole("button", { name: "Close" }).click();
  await expectBrowser(trigger).toBeFocused();
  expect(await page.content()).not.toContain(key);
  await expectBrowser(
    page.getByRole("heading", { name: `new-host ${id.slice(0, 8)}` }),
  ).toBeVisible();
  await trigger.click();
  await expectBrowser(command).toContainText("<a registration key>");
  expect(await page.content()).not.toContain(key);
});

test("a key created on the API keys page works for what it was granted", async () => {
  const page = await signedInAt("api-keys");
  await page.getByRole("button", { name: "Create key" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("group", { name: "Jobs" }).getByLabel("read").check();
  await dialog.getByRole("group", { name: "Runners" }).getByLabel("read").check();
  await dialog.getByRole("button", { name: "Create key" }).click();
  await expectBrowser(dialog.getByRole("button", { name: "Copy the key" })).toBeFocused();
  const key = (await dialog.getByLabel("The new API key").innerText()).trim();
  const client = system.client({ "x-api-key": key });
  await client.jobs.counts({});
  await client.runners.list();
});
