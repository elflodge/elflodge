import type { Browser } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterAll, beforeAll, expect, onTestFinished, test } from "vite-plus/test";

import { launchDashboardBrowser, signInAt } from "../dashboard-browser.ts";
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

/** A new page, closed when the test finishes. */
async function newPage() {
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  return page;
}

test("a registration key Add Runner creates when asked registers a Runner, which the dialog and the page's list then show", async () => {
  const before = await system.owner().apiKeys.list();
  const page = await newPage();
  // Installed before the page loads, so the test can move it to the dialog's next read.
  await page.clock.install();
  await signInAt(system, page, "", OWNER, "jobs");
  // The strip's count of Runners leads to their page.
  await page
    .getByRole("region", { name: "The hub now" })
    .getByRole("link", { name: /Runners/ })
    .click();
  await page.waitForURL(`${system.origin}/dashboard/runners`);
  await page.getByRole("button", { name: "Add Runner" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Runner" });
  await dialog.getByRole("button", { name: "Create a registration key" }).click();
  await expectBrowser(dialog.getByRole("button", { name: "Copy the command" })).toBeFocused();
  const key = await dialog
    .getByLabel("The command to run on the machine")
    .locator("mark.key")
    .innerText();

  // The key in the command registers a Runner, and is an ordinary key, listed with the others.
  const { id } = await system.runnerClient({ "x-api-key": key }).register({ name: "new-host" });
  // The dialog reads the Runners every five seconds.
  await page.clock.fastForward(5_000);
  await expectBrowser(dialog.getByRole("status").filter({ hasText: "New on this Hub" })).toHaveText(
    `New on this Hub since you opened this dialog: new-host ${id.slice(0, 8)}`,
  );
  // Behind the dialog, the page lists it by name and short ID, as host names repeat.
  await dialog.getByRole("button", { name: "Close" }).click();
  await expectBrowser(
    page.getByRole("heading", { name: `new-host ${id.slice(0, 8)}` }),
  ).toBeVisible();
  const created = (await system.owner().apiKeys.list()).filter(
    (listed) => !before.some((earlier) => earlier.id === listed.id),
  );
  expect(created).toEqual([
    expect.objectContaining({ permissions: { runner: ["register"] }, expiresAt: expect.any(Date) }),
  ]);
});

test("a key created on the API keys page works for what it was granted", async () => {
  const page = await newPage();
  await signInAt(system, page, "api-keys", OWNER);
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
