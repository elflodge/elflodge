import { signedIn } from "../records.ts";
import { test } from "./dashboard.tsx";
import { acceptSignIn, expectTitle, signIn } from "./shell.ts";

// The document's title, in a file of its own, as it starts signed out.

test("the document title names the page across a navigation and back", async ({ hub, open }) => {
  const owner = signedIn("owner");
  hub.session.answers(null);
  acceptSignIn(hub, owner);
  const page = await open("change-password");
  await expectTitle("Sign in · Elflodge");
  hub.session.answers(owner);
  await signIn(page, owner);
  await expectTitle("Change password · Elflodge");
  await page
    .getByRole("navigation", { name: "Destinations" })
    .getByRole("link", { name: "Runners" })
    .click();
  await expectTitle("Runners · Elflodge");
  history.back();
  await expectTitle("Change password · Elflodge");
  history.forward();
  await expectTitle("Runners · Elflodge");
});
