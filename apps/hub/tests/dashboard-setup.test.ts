import { expect as expectBrowser } from "playwright/test";
import { afterAll, beforeAll, onTestFinished, test } from "vite-plus/test";

import { launchDashboardBrowser } from "./dashboard-browser.ts";
import { startSystem } from "./harness.ts";
import { SETUP, setupLink } from "./setup-link.ts";

// Setting up a new hub in the dashboard, with the link the hub prints.

const system = startSystem();
beforeAll(() => system.start());
afterAll(() => system.stop());

test("in a browser, the setup link creates the Organization and its owner, who is then signed in", async () => {
  const { link } = await setupLink(system);
  const browser = await launchDashboardBrowser(system);
  onTestFinished(() => browser.close());
  const page = await browser.newPage();
  const dashboard = `${system.origin}/dashboard`;

  // Signing in leads to setup while the hub has no owner.
  await page.goto(`${dashboard}/sign-in`);
  await page.getByText("Open the setup link").waitFor();

  await page.goto(link.href);
  await page.getByLabel("Organization name").fill(SETUP.organizationName);
  await page.getByLabel("Your name").fill(SETUP.name);
  await page.getByLabel("Email").fill(SETUP.email);
  const password = page.getByLabel("Password");
  await password.fill("x".repeat(129));
  await page.getByRole("button", { name: "Create owner" }).click();
  await expectBrowser(password).toHaveAccessibleDescription("At most 128 characters");
  await expectBrowser(password).toBeFocused();
  await expectBrowser(page.getByRole("alert")).toHaveCount(0);
  await password.fill(SETUP.password);
  await expectBrowser(password).toHaveAccessibleDescription("");
  await expectBrowser(password).not.toHaveAttribute("aria-invalid", "true");
  await page.getByRole("button", { name: "Create owner" }).click();
  await page.waitForURL(`${dashboard}/`);
  await page.getByRole("banner").getByText(SETUP.organizationName, { exact: true }).waitFor();
  await page.getByRole("button", { name: SETUP.name }).click();
  await page.getByText(SETUP.email).waitFor();
}, 30_000);
