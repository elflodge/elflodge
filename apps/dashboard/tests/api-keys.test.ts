import type { Page } from "playwright";
import { expect } from "vite-plus/test";

import { InvalidInput } from "../../hub/src/invalid-input.ts";
import { descriptionOnFocus, expectBrowser, runClockUntil, test, UNCERTAIN } from "./dashboard.ts";
import { anApiKey } from "./records.ts";

// The API keys page, and the key Add Runner creates: revoking a key, and creating one, whose secret
// the hub gives only in its answer.

/** A new key's answer, which carries the key itself. */
const created = (name: string) => ({ id: anApiKey(name).id, key: `elf_secret_${name.length}` });

/**
 * Has the page read the keys again, as returning to its tab does once they are stale: past Query's
 * `staleTime` of a second, with no timer fired meanwhile, such as one that announces a pending
 * action.
 */
async function readAgain(page: Page) {
  await page.clock.setSystemTime((await page.evaluate(() => Date.now())) + 2_000);
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
}

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
    await expectBrowser(page.getByRole("alertdialog")).toBeHidden();
    const notice = page.getByRole("status").filter({ hasText: /^old script .* is revoked\.$/ });
    await expectBrowser(notice).toBeFocused();

    if (reread === "lists no keys") {
      hub.apiKeys.list.answers([]);
      reads.release();
      await expectBrowser(page.getByRole("heading", { name: "No API keys yet" })).toBeVisible();
    } else {
      hub.apiKeys.list.fails();
      reads.release();
      // Query tries the read again three times, a second, two and four seconds apart, before it
      // reports the failure.
      const failure = page.getByText("The API keys could not be read");
      await runClockUntil(page, 1_000, () => failure.isVisible());
    }
    await expectBrowser(notice).toBeFocused();
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
  await expectBrowser(page.getByRole("status").filter({ hasText: /kept key a/ })).toBeFocused();

  const revokeSecond = page.getByRole("button", { name: /^Revoke kept key b/ });
  await revokeSecond.click();
  await dialog.getByRole("button", { name: "Keep it" }).click();
  await expectBrowser(revokeSecond).toBeFocused();
  await revokeSecond.press("Enter");
  await expectBrowser(dialog.getByRole("button", { name: "Keep it" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expectBrowser(revokeSecond).toBeFocused();
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
  // Nor does it answer the reads of the list the failure starts.
  hub.apiKeys.list.hold();
  await dialog.getByRole("button", revoke).click();
  await revocation.arrived;
  await page.clock.runFor(29_999);
  await expectBrowser(dialog.getByText("Working…")).toBeVisible();
  await expectBrowser(dialog.getByRole("alert")).toHaveCount(0);
  await page.clock.runFor(1);
  await expectBrowser(dialog.getByRole("alert")).toHaveText(UNCERTAIN);
  await expectBrowser(dialog.getByText("Working…")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(page.getByRole("button", revoke)).toBeFocused();
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
  await expectBrowser(
    page.getByRole("status").filter({ hasText: /first held key .* is revoked/ }),
  ).toBeFocused();
  await reads.arrived;

  const revokeSecond = { name: /^Revoke second held key/ };
  await page.getByRole("button", revokeSecond).click();
  const revocation = hub.apiKeys.revoke.hold();
  await dialog.getByRole("button", revokeSecond).click();
  await expectBrowser(dialog.getByText("Working…")).toBeVisible();
  revocation.release();
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(
    page.getByRole("status").filter({ hasText: /second held key .* is revoked/ }),
  ).toBeFocused();
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
  await expectBrowser(page.getByRole("status").filter({ hasText: "is revoked" })).toBeFocused();
  await expectBrowser(page.getByRole("row").filter({ hasText: "earlier key" })).toHaveCount(0);

  const revoke = { name: /^Revoke original revocation / };
  await page.getByRole("button", revoke).click();
  const heading = await dialog.getByRole("heading").innerText();
  const revocation = hub.apiKeys.revoke.hold();
  await dialog.getByRole("button", revoke).click();
  await revocation.arrived;
  await expectBrowser(dialog.getByText("Working…")).toBeVisible();

  // Two reads while it is pending, as on returning to the tab: first no keys, then a key created
  // meanwhile, whose row is new beside the notice, and so not made inert by the dialog.
  hub.apiKeys.list.answers([]);
  await readAgain(page);
  await expectBrowser(page.getByRole("heading", { name: "No API keys yet" })).toBeVisible();
  hub.apiKeys.list.answers([arriving]);
  await readAgain(page);
  await page.getByRole("button", { name: /^Revoke arriving key / }).click();
  await expectBrowser(dialog.getByRole("heading")).toHaveText(heading);
  await expectBrowser(dialog.getByText("Working…")).toBeVisible();

  // Its notice shows, and focus stays on the Revoke the member pressed beside the dialog.
  revocation.release();
  await expectBrowser(
    page.getByRole("status").filter({ hasText: /^original revocation .* is revoked\.$/ }),
  ).toBeVisible();
  await expectBrowser(page.getByRole("button", { name: /^Revoke arriving key / })).toBeFocused();
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
  await dialog.getByRole("group", { name: "Jobs" }).getByLabel("read").check();
  const create = dialog.getByRole("button", { name: "Create key" });
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  const held = await dialog.elementHandle();
  const creation = hub.apiKeys.create.hold();
  // And the read of the list it starts, which the answer does not wait for.
  const reads = hub.apiKeys.list.hold();
  await create.press("Enter");
  expect(await creation.arrived).toEqual({ name: "held key", permissions: { job: ["read"] } });
  await expectBrowser(dialog.getByText("Working…")).toBeVisible();
  await expectBrowser(create).toHaveAttribute("aria-disabled", "true");
  await expectBrowser(cancel).toHaveAttribute("aria-disabled", "true");
  await expectBrowser(name).toHaveJSProperty("readOnly", true);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expectBrowser(create).toBeFocused();
  await cancel.click({ force: true });
  await name.press("Enter");

  hub.apiKeys.list.answers([anApiKey("held key")]);
  creation.release();
  await reads.arrived;
  // Still the same dialog: the answer shows in it.
  await expectBrowser(dialog.getByRole("button", { name: "Copy the key" })).toBeFocused();
  await expectBrowser(dialog.getByRole("heading")).toHaveText("The new key, held key");
  await expectBrowser(dialog.getByLabel("The new API key")).toHaveText(answer.key);
  expect(await held.evaluate((element) => element.isConnected)).toBe(true);
  expect(hub.apiKeys.create.calls).toHaveLength(1);
  reads.release();

  // Once the hub has answered, Escape closes it, and the key is gone with it: opened again, the
  // dialog asks afresh, and a reload does not bring it back.
  await page.keyboard.press("Escape");
  await expectBrowser(dialog).toBeHidden();
  expect(await page.content()).not.toContain(answer.key);
  await page.getByRole("button", { name: "Create key" }).click();
  await expectBrowser(dialog.getByRole("heading")).toHaveText("Create an API key");
  await expectBrowser(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("");
  expect(await page.content()).not.toContain(answer.key);
  await page.keyboard.press("Escape");
  await page.reload();
  await expectBrowser(page.getByRole("row").filter({ hasText: "held key" })).toBeVisible();
  expect(await page.content()).not.toContain(answer.key);
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
      await dialog.getByRole("group", { name: "Jobs" }).getByLabel("read").check();
      hub.apiKeys.list.answers([anApiKey("unconfirmed")]);
    }
    await page.clearConsoleMessages();
    const answered = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === "/api-keys",
    );
    await dialog
      .getByRole("button", { name: task === "Create key" ? task : "Create a registration key" })
      .click();
    expect(await (await answered).json()).toEqual({ key });
    await expectBrowser(dialog.getByRole("alert")).toHaveText(UNCERTAIN);
    if (task === "Create key") {
      // The key it may have made shows behind the dialog, to check.
      await expectBrowser(page.locator("tbody tr", { hasText: "unconfirmed" })).toHaveCount(1);
    }
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
  let requests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api-keys") requests++;
  });

  // Permissions are required; a name is optional.
  await create.click();
  const firstAction = dialog.getByRole("checkbox").first();
  await expectBrowser(firstAction).toBeFocused();
  await expectBrowser(firstAction).toHaveJSProperty(
    "validationMessage",
    "Choose at least one action.",
  );

  const corrected = "Monthly operations reporting key";
  const submitted = `${corrected} archive`;
  await name.fill(submitted);
  await dialog.getByRole("group", { name: "Jobs" }).getByLabel("read").check();
  await create.click();
  await expectBrowser(name).toHaveJSProperty(
    "validationMessage",
    "Use a name of 32 characters or fewer. This one has 40.",
  );
  await expectBrowser(name).toBeFocused();
  await expectBrowser(name).toHaveValue(submitted);
  expect(requests).toBe(0);

  // Past the browser's check, the hub refuses the name.
  await create.evaluate((button) => button.setAttribute("formnovalidate", ""));
  await create.click();
  await expectBrowser(name).toHaveAttribute("aria-invalid", "true");
  await expectBrowser(name).toBeFocused();
  await expectBrowser(dialog.getByRole("alert")).toHaveCount(0);

  // An edit of the refused field ends its words.
  await name.fill(corrected);
  await expectBrowser(name).not.toHaveAttribute("aria-invalid", "true");
  hub.apiKeys.create.refuses("BAD_REQUEST", {
    message: "Choose another action",
    cause: new InvalidInput({
      problems: [{ message: "Choose another action", path: ["permissions", "job", 0] }],
    }),
  });
  const permissions = dialog.getByRole("group", { name: "Permissions", exact: true });
  const words = await descriptionOnFocus(permissions);
  await create.click();
  await expectBrowser(permissions).toHaveAccessibleDescription(/Choose another action/);
  await expectBrowser(permissions).toBeFocused();
  expect(await words.jsonValue()).toEqual(["Choose at least one action.", "Choose another action"]);
  await expectBrowser(dialog.getByRole("alert")).toHaveCount(0);

  hub.apiKeys.create.answers(created(corrected));
  await create.click();
  await expectBrowser(dialog.getByRole("heading")).toHaveText(`The new key, ${corrected}`);
  expect(requests).toBe(3);
  expect(hub.apiKeys.create.calls.at(-1)).toEqual({
    name: corrected,
    permissions: { job: ["read"] },
  });
});
