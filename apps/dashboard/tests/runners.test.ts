import { expect } from "vite-plus/test";

import { expectBrowser, liveRegions, runClockUntil, test } from "./dashboard.ts";
import { anApiKey, aRunner, signedIn } from "./records.ts";

// The Runners page: removing a Runner, adding one, and what a member who may not remove one sees.

/** A removal that ended no jobs and left no files. */
const NOTHING_ENDED = { endedJobs: [], jobsWithFilesLeft: [] };

test("a removal confirmed while the list is being read shows its progress and ends on its notice", async ({
  hub,
  open,
}) => {
  // Last in a list longer than the window, so the notice it ends on has to be brought into view.
  const runners = ["tall-a", "tall-b", "tall-c", "tall-d", "retired-host"].map((name) =>
    aRunner(name),
  );
  const retired = runners.at(-1);
  if (!retired) throw new Error("No Runner to remove");
  hub.runners.list.answers(runners);
  hub.runners.delete.answers(NOTHING_ENDED);
  const page = await open("runners", { viewport: { width: 800, height: 500 } });
  const record = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: /^retired-host / }) });
  const remove = { name: /^Remove retired-host / };
  await record.getByRole("button", remove).scrollIntoViewIfNeeded();
  await expectBrowser(
    page.getByRole("heading", { name: "Runners", level: 1 }),
  ).not.toBeInViewport();

  // The page reads the list every five seconds; this read, and every one after it, is held.
  const reads = hub.runners.list.hold();
  await page.clock.runFor(5_000);
  await reads.arrived;
  await record.getByRole("button", remove).click();
  const dialog = page.getByRole("alertdialog");
  const removal = hub.runners.delete.hold();
  await dialog.getByRole("button", remove).click();
  expect(await removal.arrived).toEqual({ id: retired.id });
  await expectBrowser(dialog.getByText("Working…")).toBeVisible();
  await expectBrowser(dialog.getByRole("button", remove)).toBeFocused();

  hub.runners.list.answers(runners.slice(0, -1));
  removal.release();
  const notice = page.getByRole("status").filter({ hasText: /^retired-host .* is removed\./ });
  await expectBrowser(notice).toBeFocused();
  await expectBrowser(notice).toBeInViewport();
  await expectBrowser(dialog).toHaveCount(0);
  // Its record goes once the list is read.
  await expectBrowser(record).toBeVisible();
  reads.release();
  await expectBrowser(record).toHaveCount(0);
  expect(hub.runners.delete.calls).toEqual([{ id: retired.id }]);
});

test("removing an already removed Runner closes the dialog, explains its absence and drops its record", async ({
  hub,
  open,
}) => {
  const former = aRunner("former-host");
  const label = `former-host ${former.id.slice(0, 8)}`;
  hub.runners.list.answers([former]);
  const page = await open("runners");
  const record = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: label }) });
  const remove = { name: `Remove ${label}` };
  await record.getByRole("button", remove).click();
  const dialog = page.getByRole("alertdialog");

  // Another member removed it after the page last read the list, which still shows it.
  hub.runners.delete.refuses("NOT_FOUND");
  hub.runners.list.answers([]);
  const reads = hub.runners.list.calls.length;
  await dialog.getByRole("button", remove).click();
  await expectBrowser(dialog).toHaveCount(0);
  const notice = page.getByRole("status").filter({ hasText: "is already gone" });
  await expectBrowser(notice).toHaveText(`${label} is already gone.`);
  await expectBrowser(notice).toBeFocused();
  // One read of the list told it was gone; the page took its record off without reading it again.
  await expectBrowser(record).toHaveCount(0);
  expect(hub.runners.list.calls).toHaveLength(reads + 1);
});

test("a Runner a read drops while its dialog is open is still named there, and is already gone", async ({
  hub,
  open,
}) => {
  const former = aRunner("dropped-host");
  const label = `dropped-host ${former.id.slice(0, 8)}`;
  hub.runners.list.answers([former]);
  const page = await open("runners");
  const record = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: label }) });
  const remove = { name: `Remove ${label}` };
  await record.getByRole("button", remove).click();
  const dialog = page.getByRole("alertdialog");
  await expectBrowser(dialog.getByRole("heading")).toHaveText(`Remove ${label}?`);

  // Another member removes it. The page's next read of the list drops its record, and the open
  // dialog still names it.
  hub.runners.list.answers([]);
  await page.clock.runFor(5_000);
  await expectBrowser(record).toHaveCount(0);
  await expectBrowser(dialog.getByRole("heading")).toHaveText(`Remove ${label}?`);

  hub.runners.delete.refuses("NOT_FOUND");
  await dialog.getByRole("button", remove).click();
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(
    page.getByRole("status").filter({ hasText: `${label} is already gone.` }),
  ).toBeFocused();
  expect(hub.runners.delete.calls).toEqual([{ id: former.id }]);
});

test("Add Runner cannot be left while its key is created, then shows the key in the command and announces a copy without it", async ({
  hub,
  open,
}) => {
  const answer = { id: anApiKey("Runner registration").id, key: "elf_registration_secret" };
  hub.apiKeys.create.answers(answer);
  const page = await open("runners", { permissions: ["clipboard-read", "clipboard-write"] });
  const trigger = page.getByRole("button", { name: "Add Runner" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Add Runner" });
  await expectBrowser(dialog).toBeFocused();
  // On this machine's address the hub is named by what the member puts in, and the key too, until
  // they ask for one: opening it created nothing.
  const command = dialog.getByLabel("The command to run on the machine");
  await expectBrowser(command).toContainText("HUB_URL=<the hub's URL from that machine>");
  await expectBrowser(command).toContainText("<a registration key>");
  await expectBrowser(command).not.toContainText(new URL(page.url()).origin);
  expect(hub.apiKeys.create.calls).toEqual([]);
  await expectBrowser(
    dialog.getByRole("status").filter({ hasText: /^Waiting for a Runner to register\./ }),
  ).toBeVisible();

  const create = dialog.getByRole("button", { name: "Create a registration key" });
  const close = dialog.getByRole("button", { name: "Close" });
  const creation = hub.apiKeys.create.hold();
  await create.press("Enter");
  expect(await creation.arrived).toEqual({
    name: "Runner registration",
    permissions: { runner: ["register"] },
    expiresIn: 86_400,
  });
  await expectBrowser(create).toBeFocused();
  await expectBrowser(create).toHaveAttribute("aria-busy", "true");
  await expectBrowser(close).toBeDisabled();
  // Followed now, a link would leave the dialog before the key arrives in it.
  for (const name of ["Runners on other machines", "the Runner's README"]) {
    const link = dialog.getByRole("link", { name });
    await expectBrowser(link).toHaveAttribute("aria-disabled", "true");
    await expectBrowser(link).toHaveJSProperty("tabIndex", -1);
    await link.click({ force: true });
    await link.press("Enter");
    await expectBrowser(dialog).toBeVisible();
  }
  await create.focus();
  // Screen readers hear it once the request has run for a second.
  const working = page.getByRole("status").filter({ hasText: /^Working…$/ });
  await runClockUntil(page, 500, async () => (await working.count()) === 1);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await close.focus();
  await expectBrowser(close).toBeFocused();
  await page.keyboard.press("Enter");
  await page.mouse.click(1, 1);
  await expectBrowser(dialog).toBeVisible();

  creation.release();
  const copyLine = dialog.locator("p.copy");
  const copy = copyLine.getByRole("button", { name: "Copy the command" });
  await expectBrowser(copy).toBeFocused();
  await expectBrowser(copy).toHaveAccessibleDescription(/^Shown this once: the registration key/);
  await expectBrowser(command.locator("mark.key")).toHaveText(answer.key);
  expect(hub.apiKeys.create.calls).toHaveLength(1);

  // Copying says so through UI SDK's live region, outside the dialog and never inert, which writes
  // it 100 ms after the press; no announcement carries the key.
  await copy.click();
  await page.clock.runFor(100);
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
  expect((await live.allTextContents()).some((message) => message.includes(answer.key))).toBe(
    false,
  );

  // Closing it forgets the key: opened again, it asks afresh.
  await close.click();
  await expectBrowser(trigger).toBeFocused();
  expect(await page.content()).not.toContain(answer.key);
  await trigger.click();
  await expectBrowser(command).toContainText("<a registration key>");
  expect(await page.content()).not.toContain(answer.key);
});

test("a plain member gets no owner's actions on Runners and API keys", async ({ hub, open }) => {
  hub.session.answers(signedIn("member"));
  hub.runners.list.answers([aRunner("shared-host")]);
  const page = await open("runners");
  const record = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: /^shared-host / }) });
  await expectBrowser(record).toBeVisible();
  await expectBrowser(record.getByRole("button", { name: /^Remove / })).toHaveCount(0);

  // Add Runner gives the command, for a key the member holds.
  await page.getByRole("button", { name: "Add Runner" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Runner" });
  await expectBrowser(dialog.getByLabel("The command to run on the machine")).toContainText(
    "<a registration key>",
  );
  await expectBrowser(
    dialog.getByRole("button", { name: "Create a registration key" }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).click();

  // Nor does the API keys page read the keys: the stand-in has no answer for that.
  await page
    .getByRole("navigation", { name: "Destinations" })
    .getByRole("link", { name: "API keys" })
    .click();
  await expectBrowser(page.getByText("Only owners and admins see and manage")).toBeVisible();
  await expectBrowser(page.getByRole("button", { name: "Create key" })).toHaveCount(0);
});
