import type { Browser, Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterAll, beforeAll, expect, onTestFinished, test } from "vite-plus/test";

import { launchDashboardBrowser, signInAt } from "../dashboard-browser.ts";
import { blobRef, OWNER, startSystem } from "../harness.ts";

// What the hub takes from the submit pages: what a submission creates, what it refuses, and what a
// retry after a lost answer cannot create twice.

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

/** Opens the dashboard's `pathname` in a new page, signed in there as the owner. */
async function signedInAt(pathname: string): Promise<Page> {
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  await signInAt(system, page, pathname, OWNER);
  return page;
}

/** Chooses files of these names and texts with Add files. */
async function addFiles(page: Page, files: readonly (readonly [string, string])[]) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add files" }).click();
  await (
    await chooser
  ).setFiles(
    files.map(([name, text]) => ({ name, mimeType: "text/plain", buffer: Buffer.from(text) })),
  );
}

test("a Batch of typed jobs and jobs from files is created whole, and the member lands on it", async () => {
  const page = await signedInAt("batches/-/new");
  const files = [
    ["invoice-117.pdf", "Invoice 117: 3 oak shelves, 405.00 EUR."],
    ["invoice-118.pdf", "Invoice 118: 12 hinges, 54.00 EUR."],
  ] as const;
  await page.getByLabel("Instructions").fill("Say whether the invoice's lines add up.");
  await page.getByLabel("Batch ID").fill("invoices-2026-11");
  await page.getByRole("button", { name: "Add a Label" }).click();
  await page.getByLabel("Key of Label 1").fill("customer");
  await page.getByLabel("Value of Label 1").fill("Harbor & Pine");
  await addFiles(page, files);
  await page.getByRole("button", { name: "Add a job" }).click();
  await page.getByLabel("Input of job 3").fill("Invoice 119, by phone: 64.80 EUR.");
  await page.getByRole("button", { name: "Submit Batch" }).click();

  await expectBrowser(page.getByRole("heading", { level: 1 })).toContainText("invoices-2026-11");
  await expectBrowser(page.getByRole("row", { name: /All its jobs/ })).toContainText("3");
  await expectBrowser(page.getByRole("complementary")).toContainText("customer=Harbor & Pine");
  const listed = await system.owner().jobs.list({ batchId: "invoices-2026-11" });
  expect(new Set(listed.jobs.map(({ customId }) => customId))).toEqual(
    new Set(["invoice-117.pdf", "invoice-118.pdf", "job-1"]),
  );
  expect(listed.jobs.every(({ labels }) => labels.customer === "Harbor & Pine")).toBe(true);
  // Uploaded by digest, so the hub holds each file's content.
  const held = await system.owner().blobs.check({ files: files.map(([, text]) => blobRef(text)) });
  expect(held.files.map(({ stored }) => stored)).toEqual([true, true]);
});

test("the hub's refusals stand at the field or row concerned, with every value kept", async () => {
  await system.owner().batches.create({
    id: "receipts-2026-11",
    // The page's own starting Output schema, so the Batch matches but for its job.
    agent: {
      outputContract: {
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      },
    },
    jobs: [{ customId: "job-1", input: "Receipt 1: 12.00 EUR." }],
  });
  const page = await signedInAt("batches/-/new");
  await page.getByRole("button", { name: "Add a job" }).click();
  await page.getByLabel("Input of job 1").fill("Receipt 1: 21.00 EUR.");
  await addFiles(page, [["receipt-2.txt", "Receipt 2: 8.50 EUR."]]);
  await page.getByLabel("Batch ID").fill("receipts-2026-11-new");
  // Over JOB_MODEL_BUDGET_USD_MAX, which the hub refuses at the field.
  const budget = page.getByLabel("Model budget");
  await budget.fill("6");
  const submit = page.getByRole("button", { name: "Submit Batch" });
  await submit.click();
  await expectBrowser(budget).toBeFocused();
  await expectBrowser(budget).toHaveAccessibleDescription(/Must be at most 5, the hub's maximum/);
  await expectBrowser(page.getByLabel("Input of job 1")).toHaveValue("Receipt 1: 21.00 EUR.");
  await expectBrowser(page.getByRole("cell", { name: /^receipt-2\.txt \d/ })).toBeVisible();

  // Into the Batch that has a job-1 of other content, which the hub refuses at its row.
  await budget.fill("");
  await page.getByLabel("Batch ID").fill("receipts-2026-11");
  await submit.click();
  const customId = page.getByLabel("Custom ID of job 1");
  await expectBrowser(customId).toBeFocused();
  await expectBrowser(customId).toHaveAccessibleDescription(
    /Already used in the Batch for a job with other content/,
  );
  // In the page's main: UI SDK keeps its shared live regions, one an alert, beside it.
  await expectBrowser(page.getByRole("main").getByRole("alert")).toHaveText(
    "1 job was refused. It says why at its row: 1",
  );
  await expectBrowser(page.getByLabel("Input of job 1")).toHaveValue("Receipt 1: 21.00 EUR.");
  await expectBrowser(page.getByLabel("Batch ID")).toHaveValue("receipts-2026-11");
  const { jobs } = await system.owner().jobs.list({ batchId: "receipts-2026-11" });
  expect(jobs.map((job) => job.customId)).toEqual(["job-1"]);
});

test("after a lost answer, the Batch's link opens the Batch the hub made in a tab beside the draft, which stays", async () => {
  const page = await signedInAt("batches/-/new");
  await page.getByRole("button", { name: "Add a job" }).click();
  await page.getByLabel("Input of job 1").fill("Receipt 3: 4.20 EUR.");
  await page.route("**/batches", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    // The hub makes the Batch; its answer never reaches the page. The browser alone resolves the
    // hub's name, so the request goes to the hub's address.
    await route.fetch({ url: route.request().url().replace(system.origin, system.url().origin) });
    await route.abort("connectionreset");
  });
  await page.getByRole("button", { name: "Submit Batch" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "may already have a Batch" });
  await alert.waitFor();
  // The ID the draft sent, which its field holds once sent.
  const sentId = await page.getByLabel("Batch ID").inputValue();
  await expectBrowser(alert).toContainText(`under this Batch ID: ${sentId} (opens in a new tab)`);

  const [tab] = await Promise.all([
    page.context().waitForEvent("page"),
    alert.getByRole("link", { name: sentId }).click(),
  ]);
  onTestFinished(() => tab.close());
  await expectBrowser(tab.getByRole("heading", { level: 1 })).toContainText(sentId);
  await expectBrowser(tab.getByRole("row", { name: /All its jobs/ })).toContainText("1");
  await expectBrowser(page.getByRole("heading", { level: 1 })).toHaveText("Submit a Batch");
  await expectBrowser(page.getByLabel("Batch ID")).toHaveValue(sentId);
  await expectBrowser(page.getByLabel("Input of job 1")).toHaveValue("Receipt 3: 4.20 EUR.");
});

test("after a lost answer the Custom ID field holds the ID sent: an edit cannot make a second job, and another ID says one may exist", async () => {
  const page = await signedInAt("jobs/new");
  const input = page.getByLabel("Input", { exact: true });
  await input.fill("Count the receipts.");
  await page.getByRole("button", { name: "Add a Label" }).click();
  await page.getByLabel("Key of Label 1").fill("customer");
  await page.getByLabel("Value of Label 1").fill("Harbor & Pine");
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
  // The same values again open the job the first submission made, with its Label.
  await customId.fill(sentId);
  await input.fill("Count the receipts.");
  await submit.click();
  await expectBrowser(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  await expectBrowser(page.getByRole("heading", { level: 1 })).toContainText(sentId);
  await expectBrowser(page.getByRole("listitem").filter({ hasText: "customer" })).toHaveText(
    "customer=Harbor & Pine",
  );
  const { jobs } = await system.owner().jobs.list({ batchId: sentId });
  expect(jobs).toHaveLength(1);
  expect(page.url()).toBe(`${system.origin}/dashboard/jobs/${jobs[0]?.id}`);
});
