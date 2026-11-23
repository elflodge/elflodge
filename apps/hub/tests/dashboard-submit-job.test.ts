import type { Browser } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterAll, beforeAll, expect, onTestFinished, test } from "vite-plus/test";

import { launchDashboardBrowser, liveRegions, newMember, signInAt } from "./dashboard-browser.ts";
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
  await page.clock.install();
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
  // Allow a queued polite announcement to reach its region. Focus already describes the refusal.
  await page.clock.runFor(500);
  await expectBrowser(liveRegions(page).filter({ hasText: "the hub's maximum" })).toHaveCount(0);
  for (const [label, value] of values)
    await expectBrowser(page.getByLabel(label)).toHaveValue(value);
  await budget.fill(".5");
  await expectBrowser(budget).not.toHaveAttribute("aria-invalid", "true");
  await expectBrowser(timeout).toHaveAttribute("aria-invalid", "true");
  await timeout.fill("60");
  await page.getByRole("button", { name: "Submit job" }).click();
  await expectBrowser(page.getByRole("heading", { level: 1 })).toContainText("invoice-17");
}, 30_000);

test("a job submitted with Labels carries them", async () => {
  const page = await openSubmitJob("Job labeller");
  await page.getByLabel("Input", { exact: true }).fill("Count the invoices.");
  await page.getByRole("button", { name: "Add a Label" }).click();
  await page.getByLabel("Key of Label 1").fill("customer");
  await page.getByLabel("Value of Label 1").fill("Harbor & Pine");
  await page.getByRole("button", { name: "Submit job" }).click();
  await expectBrowser(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  await expectBrowser(page.getByRole("listitem").filter({ hasText: "customer" })).toHaveText(
    "customer=Harbor & Pine",
  );
}, 30_000);

test("a member leaving typed input, by a link or by Back, can stay with the draft or discard it", async () => {
  const page = await openSubmitJob("Draft writer");
  const input = page.getByLabel("Input", { exact: true });
  const jobs = page
    .getByRole("navigation", { name: "Where this is" })
    .getByRole("link", { name: "Jobs" });
  const dialog = page.getByRole("alertdialog", { name: "Leave without submitting?" });
  const stay = dialog.getByRole("button", { name: "Stay" });
  await input.fill("Still writing.");
  await jobs.click();
  await expectBrowser(stay).toBeFocused();
  await page.keyboard.press("Escape");
  await expectBrowser(dialog).toBeHidden();
  await expectBrowser(input).toHaveValue("Still writing.");
  await jobs.click();
  await stay.click();
  await expectBrowser(dialog).toBeHidden();
  await expectBrowser(jobs).toBeFocused();
  await page.goBack();
  await stay.click();
  await expectBrowser(dialog).toBeHidden();
  await expectBrowser(page).toHaveURL(/\/jobs\/new$/);
  await expectBrowser(input).toHaveValue("Still writing.");
  const entries = await page.evaluate("history.length");
  await jobs.click();
  await dialog.getByRole("button", { name: "Leave the page" }).click();
  await expectBrowser(page.getByRole("heading", { name: "Jobs", exact: true })).toBeVisible();
  await expectBrowser(dialog).toBeHidden();
  expect(await page.evaluate("history.length")).toBe(Number(entries) + 1);
  await expectBrowser(page.locator("[inert]")).toHaveCount(0);
  await expectBrowser(page.locator('[data-slot="alert-dialog-content"]')).toHaveCount(0);
}, 30_000);

test("after a lost answer the Custom ID field holds the ID sent: an edit cannot make a second job, and another ID says one may exist", async () => {
  const page = await openSubmitJob("Job retrier");
  const input = page.getByLabel("Input", { exact: true });
  await input.fill("Count the receipts.");
  let firstStatus: number | undefined;
  await page.route("**/batches", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    // The hub makes the job; its answer never reaches the page. The browser alone resolves the
    // hub's name, so the request goes to the hub's address.
    const answer = await route.fetch({
      url: route.request().url().replace(system.origin, system.url().origin),
    });
    firstStatus = answer.status();
    await route.abort("connectionreset");
  });
  const submit = page.getByRole("button", { name: "Submit job" });
  const customId = page.getByLabel("Custom ID");
  const alert = page.getByRole("alert");
  const create = page.waitForRequest(
    (request) =>
      request.method() === "POST" && new URL(request.url()).pathname.endsWith("/batches"),
  );
  await submit.click();
  const sentId: string = (await create).postDataJSON().id;
  await expectBrowser(alert).toContainText(
    `The hub may already have a job under this Custom ID: ${sentId} (opens in a new tab). Submit again to find out: if it was made, the same values return that job and changed ones are refused at Custom ID. To submit another job, change the Custom ID or clear it.`,
  );
  expect(firstStatus).toBe(200);
  await expectBrowser(customId).toHaveValue(sentId);
  await page.unrouteAll({ behavior: "wait" });

  // An edit keeps the ID, so the hub refuses the changed job instead of making a second one.
  await input.fill("Count the receipts twice.");
  await submit.click();
  await expectBrowser(customId).toHaveAttribute("aria-invalid", "true");
  await customId.fill("receipts-again");
  await expectBrowser(alert).toHaveText(
    `The hub may already have a job from an earlier submission: ${sentId} (opens in a new tab). Submitting now goes under another Custom ID and leaves that one as it is.`,
  );
  await customId.fill(sentId);
  await input.fill("Count the receipts.");
  await submit.click();
  await expectBrowser(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  await expectBrowser(page.getByRole("heading", { level: 1 })).toContainText(sentId);
}, 30_000);
