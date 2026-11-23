import type { Page } from "playwright";
import { expect } from "vite-plus/test";

import { expectBrowser, test } from "./dashboard.ts";
import { NOW, NO_JOBS_LISTED, aListedJob, aRunner } from "./records.ts";

// The jobs list, which the dashboard opens on: what an empty hub says to do, the filters and pages
// it reads, held in the address, and the hub strip's counts that lead to it.

/** The jobs the list shows, a row each. */
function rows(page: Page) {
  return page
    .getByRole("table", { name: "Jobs" })
    .getByRole("row")
    .filter({ has: page.getByRole("cell") });
}

test("the dashboard opens on the jobs list, which on an empty hub says to add a Runner, and once one is connected, to submit a Batch", async ({
  hub,
  open,
}) => {
  hub.jobs.list.answers(NO_JOBS_LISTED);
  const page = await open("");
  await page.waitForURL("**/dashboard/jobs");
  await expectBrowser(page.getByRole("heading", { name: "Jobs", level: 1 })).toBeVisible();
  await expectBrowser(page.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
  await expectBrowser(page.getByRole("link", { name: "Add Runner" })).toHaveAttribute(
    "href",
    "/dashboard/runners",
  );

  const batches = page
    .getByRole("navigation", { name: "Destinations" })
    .getByRole("link", { name: "Batches" });
  await batches.focus();
  await batches.hover();
  await page.clock.runFor(100);
  expect(hub.batches.list.calls).toHaveLength(0);

  // A Runner connects. The hub strip reads the Runners every five seconds, and the advice follows.
  hub.runners.list.answers([aRunner("host-1")]);
  await page.clock.runFor(5_000);
  await expectBrowser(
    page
      .getByRole("region", { name: "The hub now" })
      .getByRole("link", { name: "Runners 1 of 1 connected" }),
  ).toBeVisible();
  await expectBrowser(page.getByText("elflodge batches submit")).toBeVisible();
  await expectBrowser(page.getByRole("link", { name: "Add Runner" })).toHaveCount(0);
});

test("filters held in the address go with the list's read and survive a reload, and Apply reads the list again in place", async ({
  hub,
  open,
}) => {
  const [a, b, c] = ["a", "b", "c"].map((customId) => aListedJob(customId, { batchId: "march" }));
  if (!a || !b || !c) throw new Error("Three jobs were made");
  const cancelled = { ...b, status: "cancelled" as const, endedAt: NOW };
  hub.jobs.list.answers({ jobs: [a, cancelled, c], hasMore: false });
  const page = await open("jobs", { viewport: { width: 390, height: 844 } });
  await expectBrowser(rows(page)).toHaveCount(3);
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByRole("checkbox", { name: "Cancelled" }).check();
  await page.getByLabel("Batch").fill("march");
  // Which jobs match is the hub's to say.
  hub.jobs.list.answers({ jobs: [cancelled], hasMore: false });
  await page.getByRole("button", { name: "Apply" }).click();
  await page.waitForURL(/status=/);
  const filters = page.getByRole("button", { name: "Filters (2 applied)", exact: true });
  await expectBrowser(filters).toBeFocused();

  /** The list, its read and its closed panel show the filters survived submission or reload. */
  async function expectFiltered() {
    await expectBrowser(rows(page)).toHaveCount(1);
    expect(hub.jobs.list.calls.at(-1)).toEqual({
      status: ["cancelled"],
      batchId: "march",
      limit: 50,
    });
    await expectBrowser(filters).toHaveAttribute("aria-expanded", "false");
    await filters.click();
    await expectBrowser(page.getByRole("checkbox", { name: "Cancelled" })).toBeChecked();
    await expectBrowser(page.getByLabel("Batch")).toHaveValue("march");
  }
  await expectFiltered();
  await page.reload();
  await expectFiltered();

  // Wide enough that the form shows without its toggle, Apply again reads the list in place: it
  // keeps the focus and adds no entry to the history.
  await page.setViewportSize({ width: 1280, height: 800 });
  const apply = page.getByRole("button", { name: "Apply", exact: true });
  const entries = await page.evaluate<number>("history.length");
  const read = hub.jobs.list.hold();
  await apply.focus();
  await page.keyboard.press("Enter");
  expect(await read.arrived).toEqual({ status: ["cancelled"], batchId: "march", limit: 50 });
  await expectBrowser(apply).toBeDisabled();
  await expectBrowser(apply).toBeFocused();
  read.release();
  await expectBrowser(apply).toBeEnabled();
  await expectBrowser(apply).toBeFocused();
  expect(await page.evaluate<number>("history.length")).toBe(entries);
});

test("a link reads the exact Batch a page at a time", async ({ hub, open }) => {
  // As the hub lists them, newest first.
  const jobs = Array.from({ length: 51 }, (_, index) =>
    aListedJob(`page-${50 - index}`, { batchId: "2026" }),
  );
  hub.jobs.list.answers(({ after, limit }) => {
    const start = after === undefined ? 0 : jobs.findIndex((job) => job.id === after) + 1;
    return { jobs: jobs.slice(start, start + limit), hasMore: start + limit < jobs.length };
  });
  const page = await open("jobs?batchId=2026");
  /** The custom IDs of the jobs the list shows. */
  const names = rows(page)
    .getByRole("cell", { name: /^page-\d+/ })
    .getByText(/^page-\d+$/);
  const customIds = jobs.map((job) => job.customId);

  await expectBrowser(names).toHaveText(customIds.slice(0, 50));
  expect(hub.jobs.list.calls.at(-1)).toEqual({ status: [], batchId: "2026", limit: 50 });
  await page.getByRole("link", { name: "Older jobs" }).click();
  await expectBrowser(names).toHaveText(customIds.slice(50));
  expect(hub.jobs.list.calls.at(-1)).toEqual({
    status: [],
    batchId: "2026",
    after: jobs[49]?.id,
    limit: 50,
  });
  await expectBrowser(page.getByRole("link", { name: "Older jobs" })).toHaveCount(0);
  await page.getByRole("link", { name: "Newest jobs" }).click();
  await expectBrowser(names).toHaveText(customIds.slice(0, 50));
});

test("a count in the strip opens the list of the jobs it counts", async ({ hub, open }) => {
  const queued = aListedJob("strip-queued");
  const cancelled = aListedJob("strip-cancelled", { status: "cancelled", endedAt: NOW });
  hub.jobs.counts.answers({
    jobCounts: { queued: 1, running: 0, paused: 0 },
    statusUnknownJobCounts: { queued: 0, running: 0 },
  });
  hub.jobs.list.answers({ jobs: [queued, cancelled], hasMore: false });
  const page = await open("jobs");
  await expectBrowser(rows(page).getByText("strip-cancelled", { exact: true })).toBeVisible();

  hub.jobs.list.answers({ jobs: [queued], hasMore: false });
  await page
    .getByRole("region", { name: "The hub now" })
    .getByRole("link", { name: "1 queued" })
    .click();
  await page.waitForURL(/status=/);
  await expectBrowser(page.getByRole("checkbox", { name: "Queued" })).toBeChecked();
  await expect.poll(() => hub.jobs.list.calls.at(-1)).toEqual({ status: ["queued"], limit: 50 });
});
