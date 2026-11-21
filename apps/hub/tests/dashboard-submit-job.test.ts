import type { Browser } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterAll, beforeAll, onTestFinished, test } from "vite-plus/test";

import { launchDashboardBrowser, newMember, signInAt } from "./dashboard-browser.ts";
import { startSystem } from "./harness.ts";

const system = startSystem({ hubVars: { JOB_MODEL_BUDGET_USD_MAX: "5" } });
let browser: Browser;

beforeAll(async () => {
  await system.start();
  browser = await launchDashboardBrowser(system);
});
afterAll(async () => {
  await browser?.close();
  await system.stop();
});

async function openSubmitJob(name: string) {
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  await signInAt(system, page, "jobs", await newMember(system, name));
  await page.getByRole("link", { name: "Submit a job", exact: true }).click();
  return page;
}

test("submitting a job opens its record, including when the same Custom ID is submitted again", async () => {
  const page = await openSubmitJob("Job submitter");
  async function submit() {
    await page.getByLabel("Input", { exact: true }).fill("Count the invoices.");
    await page.getByLabel("Custom ID").fill("invoice-count");
    await page.getByRole("button", { name: "Submit job" }).click();
    await expectBrowser(page.getByRole("heading", { level: 1 })).toContainText("invoice-count");
  }
  await submit();
  const first = page.url();
  await expectBrowser(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  await page
    .getByRole("navigation", { name: "Where this is" })
    .getByRole("link", { name: "Jobs" })
    .click();
  await page.getByRole("link", { name: "Submit a job" }).click();
  await submit();
  await expectBrowser(page).toHaveURL(first);
}, 30_000);

test("a member can correct the limits the hub refused without retyping the job", async () => {
  const page = await openSubmitJob("Job editor");
  const values = [
    ["Instructions", "Read each invoice."],
    ["Input", "Invoice 17"],
    ["Output schema", '{"type":"integer"}'],
    ["Custom ID", "invoice-17"],
    ["Model budget", "6"],
    ["Run timeout", "90000"],
  ] as const;
  for (const [label, value] of values) await page.getByLabel(label).fill(value);
  await page.getByRole("button", { name: "Submit job" }).click();
  const budget = page.getByLabel("Model budget");
  const timeout = page.getByLabel("Run timeout");
  await expectBrowser(budget).toBeFocused();
  await expectBrowser(budget).toHaveAccessibleDescription(/Must be at most 5, the hub's maximum/);
  await expectBrowser(timeout).toHaveAccessibleDescription(
    /Must be at most 86400, the hub's maximum/,
  );
  for (const [label, value] of values)
    await expectBrowser(page.getByLabel(label)).toHaveValue(value);
  await budget.fill(".5");
  await expectBrowser(budget).not.toHaveAttribute("aria-invalid", "true");
  await expectBrowser(timeout).toHaveAttribute("aria-invalid", "true");
  await timeout.fill("60");
  await page.getByRole("button", { name: "Submit job" }).click();
  await expectBrowser(page.getByRole("heading", { level: 1 })).toContainText("invoice-17");
}, 30_000);

test("a member leaving typed input can stay with the draft or discard it", async () => {
  const page = await openSubmitJob("Draft writer");
  const input = page.getByLabel("Input", { exact: true });
  const jobs = page
    .getByRole("navigation", { name: "Where this is" })
    .getByRole("link", { name: "Jobs" });
  await input.fill("Still writing.");
  await jobs.click();
  const dialog = page.getByRole("dialog", { name: "Leave without submitting?" });
  await expectBrowser(dialog.getByRole("button", { name: "Stay" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expectBrowser(dialog).toBeHidden();
  await expectBrowser(input).toHaveValue("Still writing.");
  await jobs.click();
  await dialog.getByRole("button", { name: "Leave the page" }).click();
  await expectBrowser(page.getByRole("heading", { name: "Jobs", exact: true })).toBeVisible();
}, 30_000);
