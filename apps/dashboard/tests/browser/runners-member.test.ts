import { expect } from "vite-plus/test";

import { aRunner, signedIn } from "../records.ts";
import { test } from "./dashboard.tsx";

// A file of its own: the app reloads a document once another member than the first it showed is
// signed in (member-document.ts), and a file's tests share one document, in which the tests of
// runners.test.ts show an owner. Vitest gives each file a document of its own.

test("a plain member gets no owner's actions on Runners and API keys", async ({ hub, open }) => {
  hub.session.answers(signedIn("member"));
  hub.runners.list.answers([aRunner("shared-host")]);
  const page = await open("runners");
  const record = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: /^shared-host / }) });
  await expect.element(record).toBeVisible();
  await expect.element(record.getByRole("button", { name: /^Remove / })).toHaveLength(0);

  // Add Runner gives the command, for a key the member holds.
  await page.getByRole("button", { name: "Add Runner" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Runner" });
  await expect
    .element(dialog.getByLabelText("The command to run on the machine"))
    .toMatchTextContent("<a registration key>");
  await expect
    .element(dialog.getByRole("button", { name: "Create a registration key" }))
    .toHaveLength(0);
  await dialog.getByRole("button", { name: "Close" }).click();

  // Nor does the API keys page read the keys: the stand-in has no answer for that.
  await page
    .getByRole("navigation", { name: "Destinations" })
    .getByRole("link", { name: "API keys" })
    .click();
  await expect.element(page.getByText(/Only owners and admins see and manage/)).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Create key" })).toHaveLength(0);
});
