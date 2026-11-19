import type { Browser, Page } from "playwright";
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
  return page.getByRole("table", { name: "Jobs" }).locator("tbody").getByRole("row");
}

test("in a browser, the dashboard opens on the jobs list, which on an empty hub says to add a Runner", async () => {
  const page = await newPage();
  await signInAt(system, page, "", await newMember(system, "First Reader"), "jobs");

  await page.getByRole("heading", { name: "Jobs", level: 1 }).waitFor();
  await page.getByRole("heading", { name: "No jobs yet" }).waitFor();
  const add = page.getByRole("link", { name: "Add a Runner" });
  expect(await add.getAttribute("href")).toBe("/dashboard/runners");
}, 30_000);

test("in a browser, an empty hub with a Runner connected says to submit a Batch", async () => {
  const { socket } = await system.connectRunner();
  onTestFinished(() => socket.close());
  await protocolClient(socket).request("hello", { name: "host-1" }, 10_000);

  const page = await newPage();
  await signInAt(system, page, "jobs", await newMember(system, "Second Reader"));
  await page.getByRole("heading", { name: "No jobs yet" }).waitFor();
  await page.getByText("elflodge batches submit").waitFor();
  expect(await page.getByRole("link", { name: "Add a Runner" }).count()).toBe(0);
}, 30_000);

test("in a browser, the list shows a submitted job with its status", async () => {
  const client = await system.clientWithNewJobsKey();
  await submitJob(client, { ...AGENT, customId: "invoice-7", input: "Read invoice 7." });

  const page = await newPage();
  await signInAt(system, page, "jobs", await newMember(system, "Third Reader"));
  await rows(page).filter({ hasText: "invoice-7" }).getByText("Queued").waitFor();
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
  await signInAt(system, page, "jobs", await newMember(system, "Filter Reader"));
  await page.getByText("Filters").click();
  await page.getByRole("checkbox", { name: "Cancelled" }).check();
  await page.getByLabel("Batch").fill(batch.id);
  await page.getByRole("button", { name: "Apply" }).click();
  await page.waitForURL(/status=/);

  /** Expects the list to show job b alone, cancelled, with the filters that say so. */
  async function expectFiltered() {
    await expect
      .poll(() => rows(page).allInnerTexts())
      .toEqual([expect.stringMatching(/^b\s+Cancelled\s/)]);
    expect(await page.getByRole("checkbox", { name: "Cancelled" }).isChecked()).toBe(true);
    expect(await page.getByLabel("Batch").inputValue()).toBe(batch.id);
  }
  await expectFiltered();
  await page.reload();
  await expectFiltered();
}, 30_000);

test("in a browser, the list is read a page at a time, newest first", async () => {
  const client = await system.clientWithNewJobsKey();
  const batch = await client.batches.create({ agent: AGENT, breaker: false });
  const customIds = Array.from({ length: 51 }, (_, index) => `page-${index}`);
  await client.batches.addJobs({
    id: batch.id,
    jobs: customIds.map((customId) => ({ customId, input: "A job." })),
  });
  const newestFirst = (await client.jobs.list({ batchId: batch.id, limit: 100 })).jobs.map(
    ({ customId }) => customId,
  );

  const page = await newPage();
  await signInAt(system, page, `jobs?batchId=${batch.id}`, await newMember(system, "Page Reader"));
  /** The custom IDs of the jobs the list shows. */
  const shown = async () => (await rows(page).allInnerTexts()).map((text) => text.split(/\s/)[0]);

  await expect.poll(shown).toEqual(newestFirst.slice(0, 50));
  await page.getByRole("link", { name: "Older jobs" }).click();
  await expect.poll(shown).toEqual(newestFirst.slice(50));
  expect(await page.getByRole("link", { name: "Older jobs" }).count()).toBe(0);
  await page.getByRole("link", { name: "Newest jobs" }).click();
  await expect.poll(shown).toEqual(newestFirst.slice(0, 50));
}, 30_000);

test("in a browser, a count in the strip opens the list of the jobs it counts", async () => {
  const page = await newPage();
  await signInAt(system, page, "jobs", await newMember(system, "Count Reader"));
  const { jobCounts } = await system.owner().jobs.counts({});

  await page
    .getByRole("region", { name: "The hub now" })
    .getByRole("link", { name: `${jobCounts.queued} queued` })
    .click();
  await page.waitForURL(/status=/);
  expect(await page.getByRole("checkbox", { name: "Queued" }).isChecked()).toBe(true);
  // Every job shown is queued, as many as a page holds.
  await expect.poll(() => rows(page).count()).toBe(Math.min(jobCounts.queued, 50));
  expect(await rows(page).filter({ hasNotText: "Queued" }).count()).toBe(0);
}, 30_000);
