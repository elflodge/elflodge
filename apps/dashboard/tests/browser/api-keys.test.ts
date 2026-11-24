import { expect, vi } from "vite-plus/test";
import { commands, userEvent } from "vite-plus/test/browser/context";

import { InvalidInput } from "../../../hub/src/invalid-input.ts";
import { anApiKey } from "../records.ts";
import {
  advanceTo,
  check,
  descriptionOnFocus,
  focus,
  innerText,
  isVisible,
  mountAgain,
  readAgain,
  runClockUntil,
  sentRequests,
  test,
  texts,
  UNCERTAIN,
  waitForResponse,
} from "./dashboard.tsx";

// The API keys page, and the key Add Runner creates: revoking a key, and creating one, whose secret
// the hub gives only in its answer.

const readOnly = (element: Element) => element instanceof HTMLInputElement && element.readOnly;

const validationMessage = (element: Element) =>
  element instanceof HTMLInputElement ? element.validationMessage : undefined;

/** How many times the page has sent a key to be created. */
const requests = () =>
  sentRequests().filter(
    (request) => request.method === "POST" && new URL(request.url).pathname === "/api-keys",
  ).length;

/** A new key's answer, which carries the key itself. */
const created = (name: string) => ({ id: anApiKey(name).id, key: `elf_secret_${name.length}` });

test.for(["lists no keys", "fails"] as const)(
  "a revoked key's notice has focus before the list is read again, and after it %s",
  async (reread, { hub, open }) => {
    const key = anApiKey("old script");
    hub.apiKeys.list.answers([key]);
    hub.apiKeys.revoke.answers(undefined);
    const page = await open("api-keys");
    const revoke = { name: /^Revoke old script / };
    await page.getByRole("button", revoke).click();
    const reads = hub.apiKeys.list.hold();
    await page.getByRole("alertdialog").getByRole("button", revoke).click();
    await reads.arrived;
    expect(hub.apiKeys.revoke.calls).toEqual([{ id: key.id }]);
    await expect.element(page.getByRole("alertdialog")).toHaveLength(0);
    const notice = page.getByRole("status").filter({ hasText: /^old script .* is revoked\.$/ });
    await expect.element(notice).toHaveFocus();

    if (reread === "lists no keys") {
      hub.apiKeys.list.answers([]);
      reads.release();
      await expect.element(page.getByRole("heading", { name: "No API keys yet" })).toBeVisible();
    } else {
      hub.apiKeys.list.fails();
      reads.release();
      // Query tries the read again three times, a second, two and four seconds apart, before it
      // reports the failure.
      const failure = page.getByText(/^The API keys could not be read at /);
      await runClockUntil(1_000, () => isVisible(failure));
    }
    await expect.element(notice).toHaveFocus();
  },
);

test("keeping a key returns focus to its Revoke, while an earlier key's notice is shown", async ({
  hub,
  open,
}) => {
  const first = anApiKey("kept key a");
  const second = anApiKey("kept key b");
  hub.apiKeys.list.answers([first, second]);
  hub.apiKeys.revoke.answers(undefined);
  const page = await open("api-keys");
  const dialog = page.getByRole("alertdialog");
  const revokeFirst = { name: /^Revoke kept key a/ };
  await page.getByRole("button", revokeFirst).click();
  hub.apiKeys.list.answers([second]);
  await dialog.getByRole("button", revokeFirst).click();
  await expect.element(page.getByRole("status").filter({ hasText: /kept key a/ })).toHaveFocus();

  const revokeSecond = page.getByRole("button", { name: /^Revoke kept key b/ });
  await revokeSecond.click();
  await dialog.getByRole("button", { name: "Keep it" }).click();
  await expect.element(revokeSecond).toHaveFocus();
  await focus(revokeSecond);
  await userEvent.keyboard("{Enter}");
  await expect.element(dialog.getByRole("button", { name: "Keep it" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(revokeSecond).toHaveFocus();
});

test("a revocation the hub never answers ends on its own after 30 seconds, saying it may have been done", async ({
  hub,
  open,
}) => {
  hub.apiKeys.list.answers([anApiKey("unanswered key")]);
  hub.apiKeys.revoke.answers(undefined);
  const page = await open("api-keys");
  const revoke = { name: /^Revoke unanswered key/ };
  await page.getByRole("button", revoke).click();
  const dialog = page.getByRole("alertdialog");
  const revocation = hub.apiKeys.revoke.hold();
  const arrival = revocation.arrived.then(() => Date.now());
  // Nor does it answer the reads of the list the failure starts.
  hub.apiKeys.list.hold();
  await dialog.getByRole("button", revoke).click();
  await revocation.arrived;
  // The deadline runs from before the request arrived, and these steps go to fixed times after the
  // clock's reading at its arrival, so the deadline is held to between 29 and 30 seconds after it
  // however far the clock has moved since. Checked without retrying, since Vitest moves the clock
  // while any assertion retries.
  const arrivedAt = await arrival;
  await advanceTo(arrivedAt + 29_000);
  expect(dialog.getByText("Working…").element()).toBeVisible();
  expect(dialog.getByRole("alert").elements()).toHaveLength(0);
  await advanceTo(arrivedAt + 30_000);
  expect(texts(dialog.getByRole("alert"))).toEqual([UNCERTAIN]);
  await expect.element(dialog.getByText("Working…")).toHaveLength(0);
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).toHaveLength(0);
  await expect.element(page.getByRole("button", revoke)).toHaveFocus();
});

test("a second revocation while the first one's reread is unanswered shows its progress and ends on its notice", async ({
  hub,
  open,
}) => {
  const first = anApiKey("first held key");
  const second = anApiKey("second held key");
  hub.apiKeys.list.answers([first, second]);
  hub.apiKeys.revoke.answers(undefined);
  const page = await open("api-keys");
  const dialog = page.getByRole("alertdialog");
  const revokeFirst = { name: /^Revoke first held key/ };
  await page.getByRole("button", revokeFirst).click();
  // Every read of the list from the first revocation on.
  const reads = hub.apiKeys.list.hold();
  await dialog.getByRole("button", revokeFirst).click();
  await expect
    .element(page.getByRole("status").filter({ hasText: /first held key .* is revoked/ }))
    .toHaveFocus();
  await reads.arrived;

  const revokeSecond = { name: /^Revoke second held key/ };
  await page.getByRole("button", revokeSecond).click();
  const revocation = hub.apiKeys.revoke.hold();
  await dialog.getByRole("button", revokeSecond).click();
  await expect.element(dialog.getByText("Working…")).toBeVisible();
  revocation.release();
  await expect.element(dialog).toHaveLength(0);
  await expect
    .element(page.getByRole("status").filter({ hasText: /second held key .* is revoked/ }))
    .toHaveFocus();
  expect(hub.apiKeys.revoke.calls).toEqual([{ id: first.id }, { id: second.id }]);
});

test("a key listed while another's revocation is pending cannot take over its dialog", async ({
  hub,
  open,
}) => {
  const earlier = anApiKey("earlier key");
  const original = anApiKey("original revocation");
  const arriving = anApiKey("arriving key");
  hub.apiKeys.list.answers([earlier, original]);
  hub.apiKeys.revoke.answers(undefined);
  const page = await open("api-keys");
  const dialog = page.getByRole("alertdialog");
  // An earlier revocation leaves its notice, a live region, which an open dialog leaves exposed
  // with what is beside it.
  const revokeEarlier = { name: /^Revoke earlier key / };
  await page.getByRole("button", revokeEarlier).click();
  hub.apiKeys.list.answers([original]);
  await dialog.getByRole("button", revokeEarlier).click();
  await expect.element(page.getByRole("status").filter({ hasText: "is revoked" })).toHaveFocus();
  await expect.element(page.getByRole("row").filter({ hasText: "earlier key" })).toHaveLength(0);

  const revoke = { name: /^Revoke original revocation / };
  await page.getByRole("button", revoke).click();
  // A frame passes once the dialog is open, in which it makes the page beside it inert.
  await vi.advanceTimersByTimeAsync(20);
  const heading = await innerText(dialog.getByRole("heading"));
  const revocation = hub.apiKeys.revoke.hold();
  await dialog.getByRole("button", revoke).click();
  await revocation.arrived;
  await expect.element(dialog.getByText("Working…")).toBeVisible();

  // Two reads while it is pending, as on returning to the tab: first no keys, then a key created
  // meanwhile. Its Revoke can be pressed only because its row rendered after the dialog opened,
  // beside the notice, and so is not inert as what the dialog found on opening is.
  hub.apiKeys.list.answers([]);
  readAgain();
  await expect.element(page.getByRole("heading", { name: "No API keys yet" })).toBeVisible();
  hub.apiKeys.list.answers([arriving]);
  readAgain();
  await page.getByRole("button", { name: /^Revoke arriving key / }).click();
  await expect.element(dialog.getByRole("heading")).toHaveTextContent(heading);
  await expect.element(dialog.getByText("Working…")).toBeVisible();

  revocation.release();
  await expect
    .element(page.getByRole("status").filter({ hasText: /^original revocation .* is revoked\.$/ }))
    .toBeVisible();
  expect(hub.apiKeys.revoke.calls).toEqual([{ id: earlier.id }, { id: original.id }]);
});

test("Create key cannot be left while the hub answers, then shows the key with Copy focused, and forgets it once closed", async ({
  hub,
  open,
}) => {
  hub.apiKeys.list.answers([]);
  const answer = created("held key");
  hub.apiKeys.create.answers(answer);
  const page = await open("api-keys");
  await page.getByRole("button", { name: "Create key" }).click();
  const dialog = page.getByRole("dialog");
  const name = dialog.getByRole("textbox", { name: "Name" });
  await name.fill("held key");
  await check(dialog.getByRole("group", { name: "Jobs" }).getByLabelText("read"));
  const create = dialog.getByRole("button", { name: "Create key" });
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  const held = await dialog.findElement();
  const creation = hub.apiKeys.create.hold();
  // And the read of the list it starts, which the answer does not wait for.
  const reads = hub.apiKeys.list.hold();
  await focus(create);
  await userEvent.keyboard("{Enter}");
  expect(await creation.arrived).toEqual({ name: "held key", permissions: { job: ["read"] } });
  await expect.element(dialog.getByText("Working…")).toBeVisible();
  await expect.element(create).toHaveAttribute("aria-disabled", "true");
  await expect.element(cancel).toHaveAttribute("aria-disabled", "true");
  await expect.poll(async () => readOnly(await name.findElement())).toBe(true);
  await userEvent.keyboard("{Escape}");
  await userEvent.keyboard("{Enter}");
  await expect.element(create).toHaveFocus();
  await cancel.click({ force: true });
  await focus(name);
  await userEvent.keyboard("{Enter}");

  hub.apiKeys.list.answers([anApiKey("held key")]);
  creation.release();
  await reads.arrived;
  // Still the same dialog: the answer shows in it.
  await expect.element(dialog.getByRole("button", { name: "Copy the key" })).toHaveFocus();
  await expect.element(dialog.getByRole("heading")).toHaveTextContent("The new key, held key");
  await expect.element(dialog.getByLabelText("The new API key")).toHaveTextContent(answer.key);
  expect(held.isConnected).toBe(true);
  expect(hub.apiKeys.create.calls).toHaveLength(1);
  reads.release();

  // Once the hub has answered, Escape closes it, and the key is gone with it: opened again, the
  // dialog asks afresh, and the app mounting again does not bring it back.
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).toHaveLength(0);
  expect(document.documentElement.outerHTML).not.toContain(answer.key);
  await page.getByRole("button", { name: "Create key" }).click();
  await expect.element(dialog.getByRole("heading")).toHaveTextContent("Create an API key");
  await expect.element(dialog.getByRole("textbox", { name: "Name" })).toHaveDisplayValue("");
  expect(document.documentElement.outerHTML).not.toContain(answer.key);
  await userEvent.keyboard("{Escape}");
  // What a reload keeps is the address: the app mounted again there, with nothing it read before.
  mountAgain();
  await expect.element(page.getByRole("row").filter({ hasText: "held key" })).toBeVisible();
  expect(document.documentElement.outerHTML).not.toContain(answer.key);
});

// Both callers of `secretAnswerFailure`.
test.for(["Create key", "Add Runner"] as const)(
  "%s reports a malformed key answer as uncertain and keeps the key out of the console",
  async (task, { hub, open }) => {
    const { key } = created("unconfirmed");
    // The hub creates the key; its answer reaches the page without the key's ID.
    hub.apiKeys.create.answersUnchecked({ key });
    hub.apiKeys.list.answers([]);
    const page = await open(task === "Add Runner" ? "runners" : "api-keys");
    await page.getByRole("button", { name: task }).click();
    const dialog = page.getByRole("dialog");
    if (task === "Create key") {
      await dialog.getByRole("textbox", { name: "Name" }).fill("unconfirmed");
      await check(dialog.getByRole("group", { name: "Jobs" }).getByLabelText("read"));
      hub.apiKeys.list.answers([anApiKey("unconfirmed")]);
    }
    await commands.clearConsole();
    const answered = waitForResponse(
      (request) => request.method === "POST" && new URL(request.url).pathname === "/api-keys",
    );
    await dialog
      .getByRole("button", { name: task === "Create key" ? task : "Create a registration key" })
      .click();
    // The test's precondition: the answer the page received carried the key, without which finding
    // no key in the console would prove nothing.
    expect(await (await answered).json()).toEqual({ key });
    await expect.element(dialog.getByRole("alert")).toHaveTextContent(UNCERTAIN);
    if (task === "Create key") {
      // The key it may have made shows behind the dialog, to check.
      await expect
        .element(page.getByCSS("tbody tr").filter({ hasText: "unconfirmed" }))
        .toHaveLength(1);
    }
    const messages = await commands.consoleMessages(key, "error");
    expect(messages.filter(({ type }) => type === "error")).toHaveLength(1);
    expect(messages.filter((message) => message.holds)).toEqual([]);
  },
);

test("a member can correct a refused key name and keep the permissions they chose", async ({
  hub,
  open,
}) => {
  hub.apiKeys.list.answers([]);
  const page = await open("api-keys");
  await page.getByRole("button", { name: "Create key" }).click();
  const dialog = page.getByRole("dialog");
  const name = dialog.getByRole("textbox", { name: "Name" });
  const create = dialog.getByRole("button", { name: "Create key" });

  // Permissions are required; a name is optional.
  await create.click();
  const firstAction = dialog.getByRole("checkbox").first();
  await expect.element(firstAction).toHaveFocus();
  await expect
    .poll(async () => validationMessage(await firstAction.findElement()))
    .toBe("Choose at least one action.");

  const corrected = "Monthly operations reporting key";
  const submitted = `${corrected} archive`;
  await name.fill(submitted);
  await check(dialog.getByRole("group", { name: "Jobs" }).getByLabelText("read"));
  await create.click();
  await expect
    .poll(async () => validationMessage(await name.findElement()))
    .toBe("Use a name of 32 characters or fewer. This one has 40.");
  await expect.element(name).toHaveFocus();
  await expect.element(name).toHaveDisplayValue(submitted);
  expect(requests()).toBe(0);

  // Past the browser's check, the hub refuses the name.
  (await create.findElement()).setAttribute("formnovalidate", "");
  await create.click();
  await expect.element(name).toHaveAttribute("aria-invalid", "true");
  await expect.element(name).toHaveFocus();
  await expect.element(dialog.getByRole("alert")).toHaveLength(0);

  // An edit of the refused field ends its words.
  await name.fill(corrected);
  await expect.element(name).not.toHaveAttribute("aria-invalid", "true");
  hub.apiKeys.create.refuses("BAD_REQUEST", {
    message: "Choose another action",
    cause: new InvalidInput({
      problems: [{ message: "Choose another action", path: ["permissions", "job", 0] }],
    }),
  });
  const permissions = dialog.getByRole("group", { name: "Permissions" });
  const words = descriptionOnFocus(permissions);
  await create.click();
  await expect.element(permissions).toHaveAccessibleDescription(/Choose another action/);
  await expect.element(permissions).toHaveFocus();
  expect(words).toEqual(["Choose at least one action.", "Choose another action"]);
  await expect.element(dialog.getByRole("alert")).toHaveLength(0);

  hub.apiKeys.create.answers(created(corrected));
  await create.click();
  await expect.element(dialog.getByRole("heading")).toHaveTextContent(`The new key, ${corrected}`);
  expect(requests()).toBe(3);
  expect(hub.apiKeys.create.calls.at(-1)).toEqual({
    name: corrected,
    permissions: { job: ["read"] },
  });
});

/** The methods of the console, as the Console Standard names them. */
