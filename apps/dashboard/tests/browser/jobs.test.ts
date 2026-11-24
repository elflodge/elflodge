import { expect, vi } from "vite-plus/test";
import { userEvent, type BrowserPage, type Locator } from "vite-plus/test/browser/context";

import type { Hub } from "../hub.ts";
import { NOW, NO_JOBS_LISTED, aListedJob, aRunner } from "../records.ts";
import { check, focus, historyIndex, mountAgain, test, texts } from "./dashboard.tsx";

// The jobs list, which the dashboard opens on: what an empty hub says to do, the filters and pages
// it reads, held in the address, and the hub strip's counts that lead to it.

/** The jobs the list shows, a row each. */
function rows(page: BrowserPage) {
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
  await expect.poll(() => location.href).toBe(`${location.origin}/dashboard/jobs`);
  await expect.element(page.getByRole("heading", { name: "Jobs", level: 1 })).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "No jobs yet" })).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Add Runner" }))
    .toHaveAttribute("href", "/dashboard/runners");

  const batches = page
    .getByRole("navigation", { name: "Destinations" })
    .getByRole("link", { name: "Batches" });
  // Focus and the pointer on a link start no read of its page.
  await focus(batches);
  await batches.hover();
  await vi.advanceTimersByTimeAsync(100);
  expect(hub.batches.list.calls).toHaveLength(0);

  // A Runner connects. The hub strip reads the Runners every five seconds, and the advice follows.
  hub.runners.list.answers([aRunner("host-1")]);
  await vi.advanceTimersByTimeAsync(5_000);
  await expect
    .element(
      page
        .getByRole("region", { name: "The hub now" })
        .getByRole("link", { name: "Runners 1 of 1 connected" }),
    )
    .toBeVisible();
  await expect.element(page.getByText("elflodge batches submit")).toBeVisible();
  await expect.element(page.getByRole("link", { name: "Add Runner" })).toHaveLength(0);
});

test("filters held in the address go with the list's read and survive the app mounting again there, and Apply reads the list again in place", async ({
  hub,
  open,
}) => {
  const [a, b, c] = ["a", "b", "c"].map((customId) => aListedJob(customId, { batchId: "march" }));
  if (!a || !b || !c) throw new Error("Three jobs were made");
  const cancelled = { ...b, status: "cancelled" as const, endedAt: NOW };
  hub.jobs.list.answers({ jobs: [a, cancelled, c], hasMore: false });
  const page = await open("jobs", { viewport: { width: 390, height: 844 } });
  await expect.element(rows(page)).toHaveLength(3);
  await page.getByRole("button", { name: "Filters" }).click();
  await check(page.getByRole("checkbox", { name: "Cancelled" }));
  await page.getByLabelText("Batch").fill("march");
  // Which jobs match is the hub's to say.
  hub.jobs.list.answers({ jobs: [cancelled], hasMore: false });
  await page.getByRole("button", { name: "Apply" }).click();
  await expect.poll(() => location.search).toMatch(/status=/);
  const filters = page.getByRole("button", { name: "Filters (2 applied)" });
  await expect.element(filters).toHaveFocus();
  await expectFocusPastRunnersRead(hub, page, filters);

  /** The list, its read and its closed panel show the filters survived submission or a new mount. */
  async function expectFiltered() {
    await expect.element(rows(page)).toHaveLength(1);
    expect(hub.jobs.list.calls.at(-1)).toEqual({
      status: ["cancelled"],
      batchId: "march",
      limit: 50,
    });
    await expect.element(filters).toHaveAttribute("aria-expanded", "false");
    await filters.click();
    await expect.element(page.getByRole("checkbox", { name: "Cancelled" })).toBeChecked();
    await expect.element(page.getByLabelText("Batch")).toHaveValue("march");
  }
  await expectFiltered();
  // What a reload keeps is the address: the app mounted again there, with nothing it read before.
  mountAgain();
  await expectFiltered();

  // Wide enough that the form shows without its toggle, Apply again reads the list in place: it
  // keeps the focus and adds no entry to the history.
  await page.viewport(1280, 800);
  const apply = page.getByRole("button", { name: "Apply" });
  const entry = historyIndex();
  const read = hub.jobs.list.hold();
  await focus(apply);
  await userEvent.keyboard("{Enter}");
  expect(await read.arrived).toEqual({ status: ["cancelled"], batchId: "march", limit: 50 });
  await expect.element(apply).toBeDisabled();
  await expect.element(apply).toHaveFocus();
  read.release();
  await expect.element(apply).toBeEnabled();
  await expect.element(apply).toHaveFocus();
  await expectFocusPastRunnersRead(hub, page, apply);
  expect(historyIndex()).toBe(entry);
});

test("on a wide page, Apply keeps the focus while the new list and the Runners are read", async ({
  hub,
  open,
}) => {
  const [a, b] = ["a", "b"].map((customId) => aListedJob(customId));
  if (!a || !b) throw new Error("Two jobs were made");
  const cancelled = { ...b, status: "cancelled" as const, endedAt: NOW };
  hub.jobs.list.answers({ jobs: [a, cancelled], hasMore: false });
  const page = await open("jobs", { viewport: { width: 1280, height: 800 } });
  await expect.element(rows(page)).toHaveLength(2);
  await check(page.getByRole("checkbox", { name: "Cancelled" }));
  hub.jobs.list.answers({ jobs: [cancelled], hasMore: false });
  const apply = page.getByRole("button", { name: "Apply" });
  await apply.click();
  await expect.poll(() => location.search).toMatch(/status=/);
  await expect.element(rows(page)).toHaveLength(1);
  await expect.element(apply).toHaveFocus();
  await expectFocusPastRunnersRead(hub, page, apply);
});

/**
 * Focus stays on the element Apply left it on once the form offers a Runner that connected since,
 * which the hub strip reads every five seconds.
 */
async function expectFocusPastRunnersRead(hub: Hub, page: BrowserPage, focused: Locator) {
  const element = focused.element();
  hub.runners.list.answers([aRunner("host-2")]);
  await vi.advanceTimersByTimeAsync(5_000);
  await expect
    .element(page.getByCSS('select[name="runnerId"] option').filter({ hasText: "host-2" }))
    .toBeInTheDocument();
  expect(document.activeElement).toBe(element);
}

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

  await expect.poll(() => texts(names)).toEqual(customIds.slice(0, 50));
  expect(hub.jobs.list.calls.at(-1)).toEqual({ status: [], batchId: "2026", limit: 50 });
  await page.getByRole("link", { name: "Older jobs" }).click();
  await expect.poll(() => texts(names)).toEqual(customIds.slice(50));
  expect(hub.jobs.list.calls.at(-1)).toEqual({
    status: [],
    batchId: "2026",
    after: jobs[49]?.id,
    limit: 50,
  });
  await expect.element(page.getByRole("link", { name: "Older jobs" })).toHaveLength(0);
  await page.getByRole("link", { name: "Newest jobs" }).click();
  await expect.poll(() => texts(names)).toEqual(customIds.slice(0, 50));
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
  await expect.element(rows(page).getByText("strip-cancelled")).toBeVisible();

  hub.jobs.list.answers({ jobs: [queued], hasMore: false });
  await page
    .getByRole("region", { name: "The hub now" })
    .getByRole("link", { name: "1 queued" })
    .click();
  await expect.poll(() => location.search).toMatch(/status=/);
  await expect.element(page.getByRole("checkbox", { name: "Queued" })).toBeChecked();
  await expect.poll(() => hub.jobs.list.calls.at(-1)).toEqual({ status: ["queued"], limit: 50 });
});
