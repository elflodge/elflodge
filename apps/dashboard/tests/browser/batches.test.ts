import { expect, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser/context";

import { aBatch, aJob, aListedJob, jobsCounted, NOW } from "../records.ts";
import { check, mountAgain, setOffline, test, texts, UNCERTAIN } from "./dashboard.tsx";

// The Batches list and a Batch's page: its filters and pages, its controls, and the ledger of its
// jobs. Which Batches match a filter is the hub's (batches.test.ts).

test("a member pages through Batches matching a status and a Label, including once the app mounts again at their address", async ({
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
  await page.getByRole("button", { name: "Filters" }).click();
  await check(page.getByRole("checkbox", { name: "Active" }));
  await page.getByLabelText("Label key").fill("example.com/team");
  await page.getByLabelText("Label value").fill("East & West");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect.element(page.getByRole("button", { name: "Filters (2 applied)" })).toHaveFocus();
  const links = page.getByRole("table", { name: "Batches" }).getByRole("link");
  await expect.element(links).toHaveLength(50);
  await expect.element(links.first()).toHaveTextContent("statements-50");
  expect(asked()).toEqual({ status: ["active"], labels: team, limit: 50 });
  await page.getByRole("link", { name: "Older Batches" }).click();
  await expect.poll(() => texts(links)).toEqual(["statements-0"]);
  const older = { status: ["active"], labels: team, after: "statements-1", limit: 50 };
  expect(asked()).toEqual(older);
  // What a reload keeps is the address: the app mounted again there, with nothing it read before.
  let reads = hub.batches.list.calls.length;
  mountAgain();
  await expect.poll(() => texts(links)).toEqual(["statements-0"]);
  await expect.poll(() => hub.batches.list.calls.slice(reads)).toEqual([older]);
  await page.getByRole("link", { name: "Newest Batches" }).click();
  await expect.element(links.first()).toHaveTextContent("statements-50");

  // An empty value is a value: the Label's key with no text.
  await page.getByRole("button", { name: "Filters (2 applied)" }).click();
  await page.getByLabelText("Label value").fill("");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect.poll(() => texts(links)).toEqual(["other-team"]);
  const empty = { status: ["active"], labels: { "example.com/team": "" }, limit: 50 };
  expect(asked()).toEqual(empty);
  reads = hub.batches.list.calls.length;
  mountAgain();
  await expect.poll(() => texts(links)).toEqual(["other-team"]);
  await expect.poll(() => hub.batches.list.calls.slice(reads)).toEqual([empty]);

  // A Label value typed and not applied makes its key required, until Clear drops the draft with
  // the filters; a status applied then asks without a Label.
  await page.getByRole("button", { name: "Filters (2 applied)" }).click();
  await page.getByLabelText("Label value").fill("unapplied");
  // Required as the browser checks a form, which aria-required alone is not.
  await expect.element(page.getByLabelText("Label key")).toHaveAttribute("required");
  await page.getByRole("link", { name: "Clear" }).click();
  const filters = page.getByRole("button", { name: "Filters" });
  await expect.element(filters).toHaveFocus();
  await filters.click();
  await expect.element(page.getByLabelText("Label key")).toHaveValue("");
  await expect.element(page.getByLabelText("Label value")).toHaveValue("");
  await check(page.getByRole("checkbox", { name: "Active" }));
  await page.getByRole("button", { name: "Apply" }).click();
  await expect.element(page.getByRole("button", { name: "Filters (1 applied)" })).toHaveFocus();
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
  const pause = page.getByRole("button", { name: "Pause" });
  const cancel = page.getByRole("button", { name: `Cancel the Batch ${id}` });
  const pausing = hub.batches.pause.hold();
  // The hub answers with the Batch as it stands then, one of its jobs succeeded since the page's
  // last read.
  hub.batches.pause.answers({ ...paused, jobCounts: jobsCounted({ queued: 1, succeeded: 1 }) });
  await pause.click();
  expect(await pausing.arrived).toEqual({ id });
  await expect.element(pause).toBeDisabled();
  await expect.element(cancel).toBeDisabled();
  await expect.element(page.getByRole("status").filter({ hasText: "Working…" })).toBeVisible();
  // Kept out of the status region's text: the pressed button tells a screen reader it waits.
  await expect
    .element(page.getByCSS("#batch-status").getByText("Working…"))
    .toHaveAttribute("aria-hidden", "true");

  // A pause from elsewhere lands first: the next read withdraws Pause's note, and Pause stays
  // while its own request runs, described by the status.
  hub.batches.get.answers(paused);
  await vi.advanceTimersByTimeAsync(5_000);
  await expect.element(page.getByRole("button", { name: "Resume" })).toBeVisible();
  await expect.element(page.getByCSS("#pause-note")).toHaveLength(0);
  await expect.element(pause).toHaveFocus();
  await expect.element(pause).toHaveAttribute("aria-busy", "true");
  await expect.element(pause).toHaveAccessibleDescription(/By a caller/);

  // The hub answers while the counts the pause changes are read again: the page shows the answer,
  // the status takes the focus and the controls are free without waiting for them.
  const counts = hub.jobs.counts.hold();
  const reads = hub.batches.get.calls.length;
  pausing.release();
  await counts.arrived;
  const ledger = page.getByRole("table", { name: "Jobs by status" });
  await expect
    .element(ledger.getByRole("row").filter({ hasText: "Succeeded" }).getByCSS("td.num"))
    .toHaveTextContent("1");
  expect(hub.batches.get.calls).toHaveLength(reads);
  await expect.element(page.getByRole("status").filter({ hasText: "By a caller" })).toHaveFocus();
  // The Batch's status no longer waits. UI SDK's shared announcer keeps the "Working…" it announced
  // once the press had waited a second, as it keeps every announcement until the next.
  await expect.element(page.getByCSS("#batch-status").getByText("Working…")).toHaveLength(0);
  await expect.element(pause).toHaveLength(0);
  await expect.element(page.getByRole("button", { name: "Resume" })).toBeEnabled();
  await expect.element(cancel).toBeEnabled();
  counts.release();

  hub.batches.list.answers({ batches: [paused], hasMore: false });
  await page
    .getByRole("navigation", { name: "Where this is" })
    .getByRole("link", { name: "Batches" })
    .click();
  await expect.element(row).toMatchTextContent("by a caller");
  await row.getByRole("link").click();
  hub.batches.resume.answers(active);
  await page.getByRole("button", { name: "Resume" }).click();
  await expect.element(page.getByRole("status").filter({ hasText: "Active" })).toHaveFocus();
  expect(hub.batches.resume.calls).toEqual([{ id }]);

  // The list was read just before, with no time passed since, so only the answer makes it stale.
  hub.batches.list.answers({ batches: [active], hasMore: false });
  await page
    .getByRole("navigation", { name: "Where this is" })
    .getByRole("link", { name: "Batches" })
    .click();
  await expect.element(row).not.toMatchTextContent("by a caller");
  await expect.element(row).toMatchTextContent("Active");
});

test("cancelling a Batch asks first and removes its controls once final", async ({ hub, open }) => {
  const id = "withdrawn";
  hub.batches.get.answers(aBatch(id));
  hub.batches.cancel.answers(aBatch(id, { status: "cancelled" }));
  const page = await open(`batches/${id}`);
  await page.getByRole("button", { name: `Cancel the Batch ${id}` }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Cancel the Batch" }).click();
  await expect.element(page.getByRole("status").filter({ hasText: "Cancelled" })).toHaveFocus();
  await expect
    .element(
      page
        .getByRole("main")
        .getByRole("button", { name: /^(Pause|Resume|Cancel(?: the Batch .+)?)$/ }),
    )
    .toHaveLength(0);
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
  setOffline(true);
  await dialog.getByRole("button", { name: "Cancel the Batch" }).click();
  await expect.element(dialog.getByRole("alert")).toHaveTextContent(UNCERTAIN);

  // Back online, Query would send a cancel it held before it reads the shown Batch again, at the
  // next poll.
  const reads = hub.batches.get.calls.length;
  setOffline(false);
  await vi.advanceTimersByTimeAsync(5_000);
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
  for (const words of atPress) await expect.element(dialog).toMatchTextContent(words);
  const confirm = dialog.getByRole("button", { name: "Cancel the Batch" });
  await userEvent.tab();
  await expect.element(confirm).toHaveFocus();

  // Polls move the page's counts, and not the dialog's.
  hub.batches.get.answers(
    aBatch(id, { jobCounts: jobsCounted({ queued: 2, running: 1 }), statusUnknownJobs: 2 }),
  );
  await vi.advanceTimersByTimeAsync(5_000);
  await expect.element(page.getByCSS("#cancel-note")).toMatchTextContent("3 unfinished jobs");
  await expect.element(page.getByCSS("main")).toMatchTextContent("2 of these have status unknown");
  for (const words of atPress) await expect.element(dialog).toMatchTextContent(words);

  // Another caller cancels it: the dialog says so and sends nothing.
  hub.batches.get.answers(
    aBatch(id, {
      jobCounts: jobsCounted({ queued: 2, running: 1 }),
      statusUnknownJobs: 2,
      pendingControl: { type: "cancel", requestedAt: NOW },
    }),
  );
  await vi.advanceTimersByTimeAsync(5_000);
  await expect.element(dialog).toMatchTextContent("Cancel has already been asked.");
  await expect.element(confirm).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await confirm.click({ force: true });
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).toHaveLength(0);
  await expect.element(cancel).toHaveFocus();
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
  await expect
    .element(page.getByRole("status").filter({ hasText: "Active" }))
    .toMatchTextContent("1 job waiting for its Canary");
  await expect.element(page.getByRole("complementary")).toMatchTextContent("Canary of 1 job only");

  await page.getByRole("link", { name: /See them.*its queued jobs/ }).click();
  const table = page.getByRole("table", { name: "Jobs" });
  await expect
    .poll(() => hub.jobs.list.calls.at(-1))
    .toMatchObject({ batchId: id, status: ["queued"] });
  await expect
    .element(table.getByRole("link", { name: id }).first())
    .toHaveAttribute("href", `/dashboard/batches/${id}`);
  await table.getByRole("link", { name: "keep" }).click();
  await page
    .getByRole("navigation", { name: "Where this is" })
    .getByRole("link", { name: id })
    .click();
  await expect.element(page.getByRole("heading", { level: 1 })).toMatchTextContent(id);
});
