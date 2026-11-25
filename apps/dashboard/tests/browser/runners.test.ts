import { expect, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser/context";

import { anApiKey, aRunner } from "../records.ts";
import { focus, liveRegions, readAgain, runClockUntil, test } from "./dashboard.tsx";

// The Runners page: removing a Runner, adding one, and what a member who may not remove one sees.

const tabIndex = (element: Element) =>
  element instanceof HTMLElement ? element.tabIndex : undefined;

/** A removal that ended no jobs and left no files. */
const NOTHING_ENDED = { endedJobs: [], jobsWithFilesLeft: [] };

test("a removal confirmed while the list is being read shows its progress, cannot be sent again or left until the hub answers, and ends on its notice", async ({
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
  (await record.getByRole("button", remove).findElement()).scrollIntoView({ block: "center" });
  await expect
    .element(page.getByRole("heading", { name: "Runners", level: 1 }))
    .not.toBeInViewport();

  // The page reads the list every five seconds; this read, and every one after it, is held. The hub
  // answers this one as it stood then, with the Runner, and every later one without it.
  let answered = 0;
  hub.runners.list.answers(() => (answered++ === 0 ? runners : runners.slice(0, -1)));
  const reads = hub.runners.list.hold();
  await vi.advanceTimersByTimeAsync(5_000);
  await reads.arrived;
  await record.getByRole("button", remove).click();
  const dialog = page.getByRole("alertdialog");
  const removal = hub.runners.delete.hold();
  await dialog.getByRole("button", remove).click();
  expect(await removal.arrived).toEqual({ id: retired.id });
  await expect.element(dialog.getByText("Working…")).toBeVisible();
  await expect.element(dialog.getByRole("button", remove)).toHaveFocus();
  // Until the hub answers, a second press sends nothing more, and the dialog cannot be left.
  await userEvent.keyboard("{Enter}");
  await dialog.getByRole("button", remove).click({ force: true });
  await userEvent.keyboard("{Escape}");
  await userEvent.pointer({ coords: { x: 1, y: 1 }, keys: "[MouseLeft]" });
  await expect.element(dialog.getByText("Working…")).toBeVisible();

  removal.release();
  const notice = page.getByRole("status").filter({ hasText: /^retired-host .* is removed\./ });
  await expect.element(notice).toHaveFocus();
  await expect.element(notice).toBeInViewport();
  await expect.element(dialog).toHaveLength(0);
  // Its record goes once the list is read after the removal.
  await expect.element(record).toBeVisible();
  reads.release();
  await expect.element(record).toHaveLength(0);
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
  await expect.element(dialog).toHaveLength(0);
  const notice = page.getByRole("status").filter({ hasText: "is already gone" });
  await expect.element(notice).toHaveTextContent(`${label} is already gone.`);
  await expect.element(notice).toHaveFocus();
  // One read of the list told it was gone; the page took its record off without reading it again.
  await expect.element(record).toHaveLength(0);
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
  await expect.element(dialog.getByRole("heading")).toHaveTextContent(`Remove ${label}?`);

  // Another member removes it. The page's next read of the list drops its record, and the open
  // dialog still names it.
  hub.runners.list.answers([]);
  await vi.advanceTimersByTimeAsync(5_000);
  await expect.element(record).toHaveLength(0);
  await expect.element(dialog.getByRole("heading")).toHaveTextContent(`Remove ${label}?`);

  hub.runners.delete.refuses("NOT_FOUND");
  await dialog.getByRole("button", remove).click();
  await expect.element(dialog).toHaveLength(0);
  await expect
    .element(page.getByRole("status").filter({ hasText: `${label} is already gone.` }))
    .toHaveFocus();
  expect(hub.runners.delete.calls).toEqual([{ id: former.id }]);
});

test("Add Runner shows every newly listed machine even when another registers first", async ({
  hub,
  open,
}) => {
  const existing = aRunner("existing-host");
  const first = aRunner("other-host");
  const second = aRunner("my-host");
  hub.runners.list.answers([existing]);
  const page = await open("runners");
  await page.getByRole("button", { name: "Add Runner" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Runner" });
  const notice = dialog
    .getByRole("status")
    .filter({ hasText: "Newly listed since you opened this dialog" });
  hub.runners.list.answers([existing, first]);
  readAgain();
  await expect.element(notice).toMatchTextContent(first.name);
  hub.runners.list.answers([existing, first, second]);
  readAgain();
  const entries = notice.getByRole("listitem");
  await expect.element(entries).toHaveLength(2);
  for (const runner of [first, second]) {
    await expect
      .element(entries.filter({ hasText: runner.name }))
      .toHaveTextContent(`${runner.name} ${runner.id.slice(0, 8)}`);
  }
});

test("Add Runner cannot be left while its key is created, then shows the key in the command and announces a copy without it", async ({
  hub,
  open,
}) => {
  const answer = { id: anApiKey("Runner registration").id, key: "elf_registration_secret" };
  hub.apiKeys.create.answers(answer);
  // The clipboard's permissions are the project's, for every test.
  const page = await open("runners");
  const trigger = page.getByRole("button", { name: "Add Runner" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Add Runner" });
  await expect.element(dialog).toHaveFocus();
  // On this machine's address the hub is named by what the member puts in, and the key too, until
  // they ask for one: opening it created nothing.
  const command = dialog.getByLabelText("The command to run on the machine");
  await expect.element(command).toMatchTextContent("HUB_URL=<the hub's URL from that machine>");
  await expect.element(command).toMatchTextContent("<a registration key>");
  await expect.element(command).not.toMatchTextContent(location.origin);
  expect(hub.apiKeys.create.calls).toEqual([]);
  await expect
    .element(dialog.getByRole("status").filter({ hasText: /^Waiting for a Runner to register\./ }))
    .toBeVisible();

  const create = dialog.getByRole("button", { name: "Create a registration key" });
  const close = dialog.getByRole("button", { name: "Close" });
  const creation = hub.apiKeys.create.hold();
  await focus(create);
  await userEvent.keyboard("{Enter}");
  expect(await creation.arrived).toEqual({
    name: "Runner registration",
    permissions: { runner: ["register"] },
    expiresIn: 86_400,
  });
  await expect.element(create).toHaveFocus();
  await expect.element(create).toHaveAttribute("aria-busy", "true");
  await expect.element(close).toBeDisabled();
  // Followed now, a link would leave the dialog before the key arrives in it.
  for (const name of ["Runners on other machines", "the Runner's README"]) {
    const link = dialog.getByRole("link", { name });
    await expect.element(link).toHaveAttribute("aria-disabled", "true");
    await expect.poll(() => tabIndex(link.element())).toBe(-1);
    await link.click({ force: true });
    await focus(link);
    await userEvent.keyboard("{Enter}");
    await expect.element(dialog).toBeVisible();
  }
  await focus(create);
  // Screen readers hear it once the request has run for a second.
  const working = page.getByRole("status").filter({ hasText: /^Working…$/ });
  await runClockUntil(500, () => working.elements().length === 1);
  await userEvent.keyboard("{Enter}");
  await userEvent.keyboard("{Escape}");
  await focus(close);
  await expect.element(close).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await userEvent.pointer({ coords: { x: 1, y: 1 }, keys: "[MouseLeft]" });
  await expect.element(dialog).toBeVisible();

  creation.release();
  const copyLine = dialog.getByCSS("p.copy");
  const copy = copyLine.getByRole("button", { name: "Copy the command" });
  await expect.element(copy).toHaveFocus();
  await expect
    .element(copy)
    .toHaveAccessibleDescription(
      /^Shown this once: the registration key.*your shell may save the registration key in its history\./,
    );
  await expect.element(command.getByCSS("mark.key")).toHaveTextContent(answer.key);
  expect(hub.apiKeys.create.calls).toHaveLength(1);

  // Copying says so through UI SDK's live region, outside the dialog and never inert, which writes
  // it 100 ms after the press; no announcement carries the key.
  await copy.click();
  await vi.advanceTimersByTimeAsync(100);
  await expect.element(copyLine.getByText("Copied.")).toBeVisible();
  const live = liveRegions();
  const result = live.filter({ hasText: "Copied." });
  await expect.element(result).toHaveLength(1);
  await expect.element(result).toHaveTextContent("Copied.");
  await expect.element(result.and(dialog.getByCSS("*"))).toHaveLength(0);
  await expect.element(result).toHaveRole("status");
  await expect.element(result).toHaveAttribute("aria-live", "polite");
  expect(result.element().closest("[inert]") === null).toBe(true);
  const copied = await navigator.clipboard.readText();
  expect(copied === command.element().textContent).toBe(true);
  expect(live.elements().some((message) => message.textContent.includes(answer.key))).toBe(false);

  // Closing it forgets the key: opened again, it asks afresh.
  await close.click();
  await expect.element(trigger).toHaveFocus();
  expect(document.documentElement.outerHTML).not.toContain(answer.key);
  await trigger.click();
  await expect.element(command).toMatchTextContent("<a registration key>");
  expect(document.documentElement.outerHTML).not.toContain(answer.key);
});
