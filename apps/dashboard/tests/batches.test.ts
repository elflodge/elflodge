import { expect } from "vite-plus/test";

import { expectBrowser, setOffline, test, UNCERTAIN } from "./dashboard.ts";
import { aBatch, aJob, aListedJob, jobsCounted, NOW } from "./records.ts";

// The Batches list and a Batch's page: its filters and pages, its controls, and the ledger of its
// jobs. Which Batches match a filter is the hub's (batches.test.ts).

test("a member pages through Batches matching a status and a Label, including after a reload", async ({
  hub,
  open,
}) => {
  const team = { "example.com/team": "East & West" };
  const statements = Array.from({ length: 51 }, (_, index) =>
    aBatch(`statements-${50 - index}`, { labels: team }),
  );
  const otherTeam = aBatch("other-team", { labels: { "example.com/team": "" } });
  hub.batches.list.answers(({ labels, after }) => {
    if (labels?.["example.com/team"] === "") return { batches: [otherTeam], hasMore: false };
    if (!labels) return { batches: [otherTeam, ...statements.slice(0, 49)], hasMore: true };
    const start = after ? statements.findIndex(({ id }) => id === after) + 1 : 0;
    return {
      batches: statements.slice(start, start + 50),
      hasMore: start + 50 < statements.length,
    };
  });
  // Narrow, where the filters fold behind their toggle.
  const page = await open("batches", { viewport: { width: 390, height: 844 } });
  const asked = () => hub.batches.list.calls.at(-1);
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByRole("checkbox", { name: "Active" }).check();
  await page.getByLabel("Label key").fill("example.com/team");
  await page.getByLabel("Label value").fill("East & West");
  await page.getByRole("button", { name: "Apply" }).click();
  await expectBrowser(page.getByRole("button", { name: "Filters (2 applied)" })).toBeFocused();
  const links = page.getByRole("table", { name: "Batches" }).getByRole("link");
  await expectBrowser(links).toHaveCount(50);
  await expectBrowser(links.first()).toHaveText("statements-50");
  expect(asked()).toEqual({ status: ["active"], labels: team, limit: 50 });
  await page.getByRole("link", { name: "Older Batches" }).click();
  await expectBrowser(links).toHaveText(["statements-0"]);
  const older = { status: ["active"], labels: team, after: "statements-1", limit: 50 };
  expect(asked()).toEqual(older);
  let reads = hub.batches.list.calls.length;
  await page.reload();
  await expectBrowser(links).toHaveText(["statements-0"]);
  await expect.poll(() => hub.batches.list.calls.slice(reads)).toEqual([older]);
  await page.getByRole("link", { name: "Newest Batches" }).click();
  await expectBrowser(links.first()).toHaveText("statements-50");

  // An empty value is a value: the Label's key with no text.
  await page.getByRole("button", { name: "Filters (2 applied)" }).click();
  await page.getByLabel("Label value").fill("");
  await page.getByRole("button", { name: "Apply" }).click();
  await expectBrowser(links).toHaveText(["other-team"]);
  const empty = { status: ["active"], labels: { "example.com/team": "" }, limit: 50 };
  expect(asked()).toEqual(empty);
  reads = hub.batches.list.calls.length;
  await page.reload();
  await expectBrowser(links).toHaveText(["other-team"]);
  await expect.poll(() => hub.batches.list.calls.slice(reads)).toEqual([empty]);

  // A Label value typed and not applied makes its key required, until Clear drops the draft with
  // the filters; a status applied then asks without a Label.
  await page.getByRole("button", { name: "Filters (2 applied)" }).click();
  await page.getByLabel("Label value").fill("unapplied");
  await expectBrowser(page.getByLabel("Label key")).toHaveJSProperty("required", true);
  await page.getByRole("link", { name: "Clear", exact: true }).click();
  const filters = page.getByRole("button", { name: "Filters", exact: true });
  await expectBrowser(filters).toBeFocused();
  await filters.click();
  await expectBrowser(page.getByLabel("Label key")).toHaveValue("");
  await expectBrowser(page.getByLabel("Label value")).toHaveValue("");
  await page.getByRole("checkbox", { name: "Active" }).check();
  await page.getByRole("button", { name: "Apply" }).click();
  await expectBrowser(page.getByRole("button", { name: "Filters (1 applied)" })).toBeFocused();
  await expect.poll(asked).toEqual({ status: ["active"], limit: 50 });
});

test("a member sees a Batch control in flight and its result on the record and list", async ({
  hub,
  open,
}) => {
  const id = "november-control";
  const jobCounts = jobsCounted({ queued: 2 });
  const active = aBatch(id, { jobCounts });
  const paused = aBatch(id, { status: "paused", pausedBy: "caller", jobCounts });
  hub.batches.list.answers({ batches: [active], hasMore: false });
  hub.batches.get.answers(active);
  const page = await open("batches");
  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: id }) });
  await row.getByRole("link").click();
  const pause = page.getByRole("button", { name: "Pause", exact: true });
  const cancel = page.getByRole("button", { name: `Cancel the Batch ${id}` });
  const pausing = hub.batches.pause.hold();
  // The hub answers with the Batch as it stands then, one of its jobs succeeded since the page's
  // last read.
  hub.batches.pause.answers({ ...paused, jobCounts: jobsCounted({ queued: 1, succeeded: 1 }) });
  await pause.click();
  expect(await pausing.arrived).toEqual({ id });
  await expectBrowser(pause).toBeDisabled();
  await expectBrowser(cancel).toBeDisabled();
  await expectBrowser(page.getByRole("status").filter({ hasText: "Working…" })).toBeVisible();
  // Kept out of the status region's text: the pressed button tells a screen reader it waits.
  await expectBrowser(page.locator("#batch-status").getByText("Working…")).toHaveAttribute(
    "aria-hidden",
    "true",
  );

  // A pause from elsewhere lands first: the next read withdraws Pause's note, and Pause stays
  // while its own request runs, described by the status.
  hub.batches.get.answers(paused);
  await page.clock.runFor(5_000);
  await expectBrowser(page.getByRole("button", { name: "Resume" })).toBeVisible();
  await expectBrowser(page.locator("#pause-note")).toHaveCount(0);
  await expectBrowser(pause).toBeFocused();
  await expectBrowser(pause).toHaveAttribute("aria-busy", "true");
  await expectBrowser(pause).toHaveAccessibleDescription(/By a caller/);

  // The hub answers while the counts the pause changes are read again: the page shows the answer,
  // the status takes the focus and the controls are free without waiting for them.
  const counts = hub.jobs.counts.hold();
  const reads = hub.batches.get.calls.length;
  pausing.release();
  await counts.arrived;
  const ledger = page.getByRole("table", { name: "Jobs by status" });
  await expectBrowser(
    ledger.getByRole("row").filter({ hasText: "Succeeded" }).locator("td.num"),
  ).toHaveText("1");
  expect(hub.batches.get.calls).toHaveLength(reads);
  await expectBrowser(page.getByRole("status").filter({ hasText: "By a caller" })).toBeFocused();
  await expectBrowser(page.getByRole("status").filter({ hasText: "Working…" })).toHaveCount(0);
  await expectBrowser(pause).toHaveCount(0);
  await expectBrowser(page.getByRole("button", { name: "Resume", exact: true })).toBeEnabled();
  await expectBrowser(cancel).toBeEnabled();
  counts.release();

  hub.batches.list.answers({ batches: [paused], hasMore: false });
  await page
    .getByRole("navigation", { name: "Where this is" })
    .getByRole("link", { name: "Batches" })
    .click();
  await expectBrowser(row).toContainText("by a caller");
  await row.getByRole("link").click();
  hub.batches.resume.answers(active);
  await page.getByRole("button", { name: "Resume" }).click();
  await expectBrowser(page.getByRole("status").filter({ hasText: "Active" })).toBeFocused();
  expect(hub.batches.resume.calls).toEqual([{ id }]);

  // The list was read just before, with no time passed since, so only the answer makes it stale.
  hub.batches.list.answers({ batches: [active], hasMore: false });
  await page
    .getByRole("navigation", { name: "Where this is" })
    .getByRole("link", { name: "Batches" })
    .click();
  await expectBrowser(row).not.toContainText("by a caller");
  await expectBrowser(row).toContainText("Active");
});

test("cancelling a Batch asks first and removes its controls once final", async ({ hub, open }) => {
  const id = "withdrawn";
  hub.batches.get.answers(aBatch(id));
  hub.batches.cancel.answers(aBatch(id, { status: "cancelled" }));
  const page = await open(`batches/${id}`);
  await page.getByRole("button", { name: `Cancel the Batch ${id}` }).click();
  const dialog = page.getByRole("alertdialog");
  await expectBrowser(dialog.getByRole("button", { name: "Keep it" })).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel the Batch", exact: true }).click();
  await expectBrowser(page.getByRole("status").filter({ hasText: "Cancelled" })).toBeFocused();
  await expectBrowser(
    page
      .getByRole("main")
      .getByRole("button", { name: /^(Pause|Resume|Cancel(?: the Batch .+)?)$/ }),
  ).toHaveCount(0);
  expect(hub.batches.cancel.calls).toEqual([{ id }]);
});

test("a cancel confirmed offline fails at once and is not sent once back online", async ({
  hub,
  open,
}) => {
  // The stand-in has no answer for the cancel: one that reaches it fails the test.
  const id = "offline-cancel";
  hub.batches.get.answers(aBatch(id));
  const page = await open(`batches/${id}`);
  await page.getByRole("button", { name: `Cancel the Batch ${id}` }).click();
  const dialog = page.getByRole("alertdialog");
  await setOffline(page, true);
  await dialog.getByRole("button", { name: "Cancel the Batch", exact: true }).click();
  await expectBrowser(dialog.getByRole("alert")).toHaveText(UNCERTAIN);

  // Back online, Query would send a cancel it held before it reads the shown Batch again, at the
  // next poll.
  const reads = hub.batches.get.calls.length;
  await setOffline(page, false);
  await page.clock.runFor(5_000);
  await expect.poll(() => hub.batches.get.calls.length).toBeGreaterThan(reads);
});

test("an open Cancel keeps the counts of its press, and shows when another caller cancels first", async ({
  hub,
  open,
}) => {
  // The stand-in has no answer for the cancel: one that reaches it fails the test.
  const id = "counted-at-press";
  hub.batches.get.answers(
    aBatch(id, { jobCounts: jobsCounted({ queued: 1, running: 1 }), statusUnknownJobs: 1 }),
  );
  const page = await open(`batches/${id}`);
  const cancel = page.getByRole("button", { name: `Cancel the Batch ${id}` });
  await cancel.click();
  const dialog = page.getByRole("alertdialog");
  const atPress = ["It has 2 unfinished jobs.", "1 of its jobs has status unknown"];
  for (const words of atPress) await expectBrowser(dialog).toContainText(words);
  const confirm = dialog.getByRole("button", { name: "Cancel the Batch", exact: true });
  await page.keyboard.press("Tab");
  await expectBrowser(confirm).toBeFocused();

  // Polls move the page's counts, and not the dialog's.
  hub.batches.get.answers(
    aBatch(id, { jobCounts: jobsCounted({ queued: 2, running: 1 }), statusUnknownJobs: 2 }),
  );
  await page.clock.runFor(5_000);
  await expectBrowser(page.locator("#cancel-note")).toContainText("3 unfinished jobs");
  await expectBrowser(page.locator("main")).toContainText("2 of these have status unknown");
  for (const words of atPress) await expectBrowser(dialog).toContainText(words);

  // Another caller cancels it: the dialog says so and sends nothing.
  hub.batches.get.answers(
    aBatch(id, {
      jobCounts: jobsCounted({ queued: 2, running: 1 }),
      statusUnknownJobs: 2,
      pendingControl: { type: "cancel", requestedAt: NOW },
    }),
  );
  await page.clock.runFor(5_000);
  await expectBrowser(dialog).toContainText("Cancel has already been asked.");
  await expectBrowser(confirm).toBeFocused();
  await page.keyboard.press("Enter");
  await confirm.click({ force: true });
  await page.keyboard.press("Escape");
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(cancel).toBeFocused();
});

test("a Batch ledger opens the jobs it counts and a job links back to the Batch", async ({
  hub,
  open,
}) => {
  // Mixed case, which the addresses keep as it is.
  const id = "MixedCase-2026";
  const jobs = ["keep", "next"].map((customId) => aListedJob(customId, { batchId: id }));
  const keep = aJob("keep", { batchId: id });
  // Its Canary of one job holds the next.
  hub.batches.get.answers(
    aBatch(id, {
      breaker: { canary: 1, maxFailurePercent: 100 },
      jobCounts: jobsCounted({ queued: 2, cancelled: 1 }),
      jobsWaitingForCanary: 1,
    }),
  );
  hub.jobs.list.answers({ jobs, hasMore: false });
  hub.jobs.get.answers(keep);
  hub.jobs.events.answers({ events: [], hasMore: false, status: keep.status, job: keep });
  const page = await open(`batches/${id}`);
  await expectBrowser(page.getByRole("status").filter({ hasText: "Active" })).toContainText(
    "1 job waiting for its Canary",
  );
  await expectBrowser(page.getByRole("complementary")).toContainText("Canary of 1 job only");

  await page.getByRole("link", { name: /See them.*its queued jobs/ }).click();
  const table = page.getByRole("table", { name: "Jobs" });
  await expectBrowser(table.locator(".job-name")).toHaveText(["keep", "next"]);
  expect(hub.jobs.list.calls.at(-1)).toMatchObject({ batchId: id, status: ["queued"] });
  await expectBrowser(table.getByRole("link", { name: id }).first()).toHaveAttribute(
    "href",
    `/dashboard/batches/${id}`,
  );
  await table.getByRole("link", { name: "keep" }).click();
  await page
    .getByRole("navigation", { name: "Where this is" })
    .getByRole("link", { name: id })
    .click();
  await expectBrowser(page.getByRole("heading", { level: 1 })).toContainText(id);
});
