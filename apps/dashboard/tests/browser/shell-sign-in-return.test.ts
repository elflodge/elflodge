import { expect } from "vite-plus/test";

import { DASHBOARD_BASE } from "../../../hub/src/dashboard.ts";
import { NO_JOBS_LISTED, signedIn } from "../records.ts";
import { test } from "./dashboard.tsx";
import { acceptSignIn, signIn } from "./shell.ts";

// Signing in from a page that required it, in a file of its own, as it starts signed out.

test("sign-in returns to the filtered Jobs link that required it", async ({ hub, open }) => {
  const owner = signedIn("owner");
  hub.session.answers(null);
  acceptSignIn(hub, owner);
  hub.jobs.list.answers(NO_JOBS_LISTED);
  const destination = "jobs?status=failed#recent";
  const page = await open(destination);
  await expect.element(page.getByLabelText("Email")).toBeVisible();
  hub.session.answers(owner);
  await signIn(page, owner);
  await expect.element(page.getByRole("heading", { name: "Jobs", level: 1 })).toBeVisible();
  expect(location.href).toBe(new URL(DASHBOARD_BASE + destination, location.origin).href);
});
