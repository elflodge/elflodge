import { expect } from "vite-plus/test";

import { signedIn } from "../records.ts";
import { test } from "./dashboard.tsx";

// The Usage page as a plain member sees it, in a file of its own: the app reloads a document once
// another member than the first it showed is signed in (member-document.ts).

test("a member learns where to read Batch usage without requesting the report", async ({
  hub,
  open,
}) => {
  // The stand-in has no answer for the report: a request for it fails the test.
  hub.session.answers(signedIn("member"));
  const page = await open("change-password");
  await page.getByRole("link", { name: "Usage" }).click();
  await expect
    .element(page.getByText(/Each Batch's page shows what that Batch has used/))
    .toBeVisible();
  // By part of its name, so a control that offers it under a longer name is absent too.
  await expect
    .element(page.getByRole("form", { name: "Usage report", exact: false }))
    .toHaveLength(0);
});
