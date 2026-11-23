import type { Browser, Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterAll, beforeAll, expect, onTestFinished, test } from "vite-plus/test";

import { launchDashboardBrowser, newMember, signInAt } from "./dashboard-browser.ts";
import { protocolClient, startSystem, submitJob } from "./harness.ts";

// The jobs list, which the dashboard opens on, as a member reads it in a browser: from an empty hub
// to a hub with jobs. The tests run in order, as the hub fills.

const system = startSystem();
let browser: Browser;

beforeAll(async () => {
  await system.start();
  browser = await launchDashboardBrowser(system);
});
afterAll(async () => {
  await browser?.close();
  await system.stop();
});

const AGENT = { outputContract: { schema: {} } };

/** A new page, closed when the test ends. */
async function newPage() {
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  return page;
}

/** The jobs the list shows, a row each. */
function rows(page: Page) {
  return page
    .getByRole("table", { name: "Jobs" })
    .getByRole("row")
    .filter({ has: page.getByRole("cell") });
}

test("in a browser, the dashboard opens on the jobs list, which on an empty hub says to add a Runner", async () => {
  const page = await newPage();
  await signInAt(system, page, "", await newMember(system, "First Reader"), "jobs");

  await page.getByRole("heading", { name: "Jobs", level: 1 }).waitFor();
  await page.getByRole("heading", { name: "No jobs yet" }).waitFor();
  const add = page.getByRole("link", { name: "Add Runner" });
  await expectBrowser(add).toHaveAttribute("href", "/dashboard/runners");
}, 30_000);

test("in a browser, an empty hub with a Runner connected says to submit a Batch", async () => {
  const { socket } = await system.connectRunner();
  onTestFinished(() => socket.close());
  await protocolClient(socket).request("hello", { name: "host-1" }, 10_000);

  const page = await newPage();
  await signInAt(system, page, "jobs", await newMember(system, "Second Reader"));
  await page.getByRole("heading", { name: "No jobs yet" }).waitFor();
  await page
    .getByRole("region", { name: "The hub now" })
    .getByRole("link", { name: "Runners 1 of 1 connected" })
    .waitFor();
  await page.getByText("elflodge batches submit").waitFor();
  await expectBrowser(page.getByRole("link", { name: "Add Runner" })).toHaveCount(0);
}, 30_000);

test("in a browser, the list shows a submitted job with its status", async () => {
  const client = await system.clientWithNewJobsKey();
  await submitJob(client, { ...AGENT, customId: "invoice-7", input: "Read invoice 7." });

  const page = await newPage();
  await signInAt(system, page, "jobs", await newMember(system, "Third Reader"));
  await rows(page).filter({ hasText: "invoice-7" }).getByText("Queued").waitFor();
}, 30_000);

test("after skipping to the end, Apply keeps focus and reads Jobs again in place", async () => {
  await submitJob(await system.clientWithNewJobsKey(), {
    ...AGENT,
    customId: "skip",
    input: "Wait.",
  });
  const page = await newPage();
  await signInAt(system, page, "jobs", await newMember(system, "Filter Form Reader"));
  // Start with a fresh document so the wait announced by sign-in cannot satisfy the assertion below.
  await page.reload();
  await page.getByRole("link", { name: "Skip to the end of the list" }).focus();
  await page.keyboard.press("Enter");
  await expectBrowser(page).toHaveURL(/#jobs-end$/);
  const entries = await page.evaluate<number>("history.length");

  const apply = page.getByRole("button", { name: "Apply", exact: true });
  const release = Promise.withResolvers<void>();
  await page.route("**/jobs", async (route) => {
    await release.promise;
    await route.continue();
  });
  await apply.focus();
  try {
    await Promise.all([page.waitForRequest("**/jobs"), page.keyboard.press("Enter")]);
    // A background poll also reads Jobs. Only Apply keeps the form pending through this read.
    await expectBrowser(apply).toBeDisabled();
    await expectBrowser(apply).toBeFocused();
    await expectBrowser(page.getByRole("status").filter({ hasText: /^Working…$/ })).toHaveCount(1);
  } finally {
    release.resolve();
  }
  await expectBrowser(apply).toBeEnabled();
  await expectBrowser(apply).toBeFocused();
  await expectBrowser(page).toHaveURL(/#jobs-end$/);
  expect(await page.evaluate<number>("history.length")).toBe(entries);
}, 30_000);

test("in a browser, filters held in the address narrow the list, and a reload keeps them", async () => {
  const client = await system.clientWithNewJobsKey();
  const batch = await client.batches.create({ agent: AGENT, breaker: false });
  const { jobs } = await client.batches.addJobs({
    id: batch.id,
    jobs: ["a", "b", "c"].map((customId) => ({ customId, input: `Job ${customId}.` })),
  });
  const cancelled = jobs.find(({ job }) => job.customId === "b");
  if (!cancelled) throw new Error("The add answered without job b");
  await client.jobs.cancel({ id: cancelled.job.id });

  const page = await newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAt(system, page, "jobs", await newMember(system, "Filter Reader"));
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByRole("checkbox", { name: "Cancelled" }).check();
  await page.getByLabel("Batch").fill(batch.id);
  await page.getByRole("button", { name: "Apply" }).click();
  await page.waitForURL(/status=/);

  const filters = page.getByRole("button", { name: "Filters (2 applied)", exact: true });
  await expectBrowser(filters).toBeFocused();

  /** The list and its closed panel show the filters survived submission or reload. */
  async function expectFiltered() {
    await expectBrowser(rows(page)).toHaveCount(1);
    await expectBrowser(rows(page).getByText("b", { exact: true })).toBeVisible();
    await expectBrowser(rows(page).getByText("Cancelled", { exact: true })).toBeVisible();
    await expectBrowser(filters).toHaveAttribute("aria-expanded", "false");
    await filters.click();
    await expectBrowser(page.getByRole("checkbox", { name: "Cancelled" })).toBeChecked();
    await expectBrowser(page.getByLabel("Batch")).toHaveValue(batch.id);
  }
  await expectFiltered();
  await page.reload();
  await expectFiltered();
}, 30_000);

test("in a browser, a link reads the exact Batch a page at a time, newest first", async () => {
  const client = await system.clientWithNewJobsKey();
  const batch = await client.batches.create({ id: "2026", agent: AGENT, breaker: false });
  const customIds = Array.from({ length: 51 }, (_, index) => `page-${index}`);
  await client.batches.addJobs({
    id: batch.id,
    jobs: customIds.map((customId) => ({ customId, input: "A job." })),
  });
  await submitJob(client, { ...AGENT, customId: "another-batch", input: "Another job." });
  const newestFirst = (await client.jobs.list({ batchId: batch.id, limit: 100 })).jobs.map(
    ({ customId }) => customId,
  );

  const page = await newPage();
  await signInAt(system, page, `jobs?batchId=${batch.id}`, await newMember(system, "Page Reader"));
  /** The custom IDs of the jobs the list shows. */
  const names = rows(page)
    .getByRole("cell", { name: /^page-\d+/ })
    .getByText(/^page-\d+$/);

  await expectBrowser(names).toHaveText(newestFirst.slice(0, 50));
  await page.getByRole("link", { name: "Older jobs" }).click();
  await expectBrowser(names).toHaveText(newestFirst.slice(50));
  await expectBrowser(page.getByRole("link", { name: "Older jobs" })).toHaveCount(0);
  await page.getByRole("link", { name: "Newest jobs" }).click();
  await expectBrowser(names).toHaveText(newestFirst.slice(0, 50));
}, 30_000);

test("in a browser, a count in the strip opens the list of the jobs it counts", async () => {
  const client = await system.clientWithNewJobsKey();
  const queuedName = "strip-queued";
  const cancelledName = "strip-cancelled";
  await submitJob(client, { ...AGENT, customId: queuedName, input: "Wait." });
  const cancelled = await submitJob(client, {
    ...AGENT,
    customId: cancelledName,
    input: "Stop.",
  });
  await client.jobs.cancel({ id: cancelled.id });

  const page = await newPage();
  await signInAt(system, page, "jobs", await newMember(system, "Count Reader"));
  await expectBrowser(rows(page).getByText(cancelledName, { exact: true })).toBeVisible();
  const { jobCounts } = await system.owner().jobs.counts({});

  await page
    .getByRole("region", { name: "The hub now" })
    .getByRole("link", { name: `${jobCounts.queued} queued` })
    .click();
  await page.waitForURL(/status=/);
  await expectBrowser(page.getByRole("checkbox", { name: "Queued" })).toBeChecked();
  await expectBrowser(rows(page).getByText(queuedName, { exact: true })).toBeVisible();
  await expectBrowser(rows(page).getByText(cancelledName, { exact: true })).toHaveCount(0);
}, 30_000);
