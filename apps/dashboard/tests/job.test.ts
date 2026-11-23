import { openFailureSchema, type Job, type JobEvent, type JobEventsPage } from "contract";
import type { Page } from "playwright";
import { expect } from "vite-plus/test";

import {
  expectBrowser,
  runClockUntil,
  test,
  type BrowserOptions,
  type Open,
  UNCERTAIN,
} from "./dashboard.ts";
import type { Hub } from "./hub.ts";
import {
  NOW,
  NO_JOBS_LISTED,
  aBatch,
  ago,
  aConversation,
  aFailure,
  aJob,
  aListedJob,
  aMessage,
  aRunner,
  aStart,
  aSuccess,
  aToolResult,
  failedFor,
  sentTo,
} from "./records.ts";

// The job page: its controls and the confirmations and form they open, and its Events, read a page
// at a time and followed as they arrive.

const RUNNER = aRunner("test-runner");

/** What a job that started a minute ago on `RUNNER` reports beside its status. */
const STARTED = { startedAt: ago(60_000), runner: sentTo(RUNNER), lastReportedAt: ago(5_000) };

/** The job with the Custom ID `customId`, running on `RUNNER`. */
function runningJob(customId: string): Job {
  return aJob(customId, { status: "running", ...STARTED });
}

/** The job with the Custom ID `customId`, ended with `output`. */
function succeededJob(customId: string, output: unknown): Job {
  return aJob(customId, { status: "succeeded", output, ...STARTED, endedAt: NOW });
}

/**
 * A started job's journal: its conversation, its start, a call of `bash` that printed 66 lines at
 * Event 10, then `entries - 1` messages, Events 20, 30 and on.
 */
function history(entries: number): JobEvent[] {
  return [
    aConversation(1),
    aStart(2),
    aToolResult(10, 66),
    ...Array.from({ length: entries - 1 }, (_, index) => aMessage((index + 2) * 10)),
  ];
}

/** A job and its journal as the hub holds them, which a test changes between steps. */
interface Journal {
  job: Job;
  events: JobEvent[];
}

/**
 * A page of `journal`'s Events as the hub reads it: past the cursor in the order asked, with the
 * job where the hub's page carries it, from the newest end and at the end of an ascending read.
 */
function eventsPage(
  journal: Journal,
  input: { order?: "asc" | "desc"; after: number; limit: number },
): JobEventsPage {
  const newestFirst = input.order === "desc";
  const past = (newestFirst ? journal.events.toReversed() : journal.events).filter(
    ({ id }) => input.after === 0 || (newestFirst ? id < input.after : id > input.after),
  );
  const hasMore = past.length > input.limit;
  const carriesJob = newestFirst ? input.after === 0 : !hasMore;
  return {
    events: past.slice(0, input.limit),
    hasMore,
    status: journal.job.status,
    ...(carriesJob ? { job: journal.job } : {}),
  };
}

/** Has the stand-in answer the job's reads from `journal` as it stands at each read. */
function serve(hub: Hub, journal: Journal) {
  hub.jobs.get.answers(() => journal.job);
  hub.jobs.events.answers((input) => eventsPage(journal, input));
}

/** Opens `journal`'s job, which the stand-in serves from it. */
async function openJob(hub: Hub, open: Open, journal: Journal, options?: BrowserOptions) {
  serve(hub, journal);
  return open(`jobs/${journal.job.id}`, options);
}

/** Its status as the page shows it. */
const statusWord = (page: Page) => page.locator(".status-lg");

/** The Output the page shows, as code. */
const output = (page: Page) => page.getByLabel("Output", { exact: true }).locator("code");

test("a member opens a job's tool calls by name, and they stay open as a count grows", async ({
  hub,
  open,
}) => {
  const job = aJob("tool-calls", {
    status: "running",
    ...STARTED,
    // Not by name, as the hub may send them.
    toolCalls: { web_search: 1, fetch_content: 1 },
  });
  const journal = { job, events: [aConversation(1), aStart(2)] };
  const page = await openJob(hub, open, journal);
  await page.getByText("Show tool calls").click();
  const table = page.getByRole("table", { name: "Tool calls by tool" });
  await expectBrowser(table.getByRole("rowheader")).toHaveText(["fetch_content", "web_search"]);
  await expectBrowser(table.getByRole("cell")).toHaveText(["1", "1"]);

  // By the page's next read, a new tool, and another call of one.
  journal.job = { ...job, toolCalls: { web_search: 2, read: 1, fetch_content: 1 } };
  await page.clock.runFor(5_000);
  await expectBrowser(table.getByRole("rowheader")).toHaveText([
    "fetch_content",
    "read",
    "web_search",
  ]);
  await expectBrowser(table.getByRole("cell")).toHaveText(["1", "1", "2"]);
  await expectBrowser(table).toBeVisible();
});

test("a member confirms deletion and sees when the job has gone", async ({ hub, open }) => {
  const queued = aJob("withdrawn-invoices");
  const cancelled = aJob("withdrawn-invoices", { status: "cancelled", endedAt: NOW });
  const journal: Journal = { job: queued, events: [] };
  serve(hub, journal);
  hub.jobs.cancel.answers(cancelled);
  hub.jobs.delete.answers({ ...cancelled, deletedAt: NOW });
  // An address names a job's UUID in either case.
  const page = await open(`jobs/${queued.id.toUpperCase()}`);
  await page.getByRole("button", { name: "Cancel the job" }).click();
  const cancellation = page.getByRole("alertdialog");
  const confirm = cancellation.getByRole("button", { name: "Cancel the job" });
  const sending = hub.jobs.cancel.hold();
  await confirm.click();
  expect(await sending.arrived).toEqual({ id: queued.id });
  await expectBrowser(confirm).toBeDisabled();
  await expectBrowser(cancellation.getByText("Working…")).toBeVisible();
  journal.job = cancelled;
  sending.release();
  await expectBrowser(
    page
      .getByRole("status")
      .filter({ hasText: "It ended before it started, so it cannot be resumed." }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Delete the job" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Delete the job" }).click();
  await expectBrowser(
    page.getByRole("status").filter({ hasText: "Deleted. Its Usage record stays." }),
  ).toBeFocused();
  // No Runner holds its files, so the page's next read of it finds none.
  hub.jobs.get.refuses("NOT_FOUND");
  await page.clock.runFor(5_000);
  await expectBrowser(page.getByRole("heading", { name: "This job was deleted" })).toBeVisible();
  await expectBrowser(
    page.getByRole("main").getByRole("link", { name: "Jobs", exact: true }),
  ).toBeVisible();
  expect(hub.jobs.delete.calls).toEqual([{ id: queued.id }]);
});

test("Cancel on a running job asks first, and a stray Enter keeps it running", async ({
  hub,
  open,
}) => {
  const job = runningJob("stray-enter");
  hub.jobs.cancel.answers({ ...job, pendingControl: { type: "cancel", requestedAt: NOW } });
  const page = await openJob(hub, open, { job, events: [aConversation(1), aStart(2)] });
  const cancel = page.getByRole("button", { name: "Cancel the job" });
  await cancel.click();
  const dialog = page.getByRole("alertdialog", { name: "Cancel this job?" });
  await expectBrowser(dialog).toContainText("Not final: it can be resumed.");
  await expectBrowser(dialog.getByRole("button", { name: "Keep it" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(cancel).toBeFocused();
  expect(hub.jobs.cancel.calls).toEqual([]);
});

test("an open Cancel's polite explanation follows the job as it starts, changes once when it ends, and then nothing on the page acts", async ({
  hub,
  open,
}) => {
  const queued = aJob("ended-under-cancel");
  const journal: Journal = { job: queued, events: [] };
  hub.batches.get.answers(aBatch("april"));
  hub.jobs.cancel.answers(queued);
  const page = await openJob(hub, open, journal);
  await page.getByRole("button", { name: "Cancel the job" }).click();
  const dialog = page.getByRole("alertdialog");
  const explanation = dialog.locator('[aria-live="polite"]');
  await expectBrowser(explanation).toHaveText(
    "Cancel ends it now. Final: it has not started, so it cannot be resumed.",
  );

  // Its Runner starts it while the member reads; the page reads it every five seconds.
  journal.job = runningJob("ended-under-cancel");
  journal.events = [aConversation(1), aStart(2)];
  await page.clock.runFor(5_000);
  await expectBrowser(explanation).toHaveText(
    "Cancel asks test-runner to stop it. Not final: it can be resumed.",
  );
  await expectBrowser(dialog.getByRole("button", { name: "Keep it" })).toBeFocused();

  // Counts the batches of mutations inside the polite live node from here on.
  await explanation.evaluate((element) => {
    new MutationObserver(() => {
      element.dataset["changes"] = String(Number(element.dataset["changes"] ?? 0) + 1);
    }).observe(element, { subtree: true, childList: true, characterData: true });
  });
  const confirm = dialog.getByRole("button", { name: "Cancel the job" });
  await page.keyboard.press("Tab");
  await expectBrowser(confirm).toBeFocused();
  // Another member cancels it.
  journal.job = { ...journal.job, status: "cancelled", endedAt: NOW };
  await page.clock.runFor(5_000);
  const ended = "This job can no longer be cancelled.";
  await expectBrowser(explanation).toHaveText(ended);
  await expectBrowser(confirm).toBeFocused();
  // Rendered behind the open dialog, Delete is inert, so it cannot take the dialog over.
  await expectBrowser(page.locator('[inert] [aria-label="Delete the job"]')).toHaveCount(1);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  await confirm.click({ force: true });
  // Two more reads of the job, which change nothing it says.
  for (const read of [1, 2]) {
    const reads = hub.jobs.events.calls.length;
    await page.clock.runFor(5_000);
    await expect
      .poll(() => hub.jobs.events.calls.length, { message: `read ${read}` })
      .toBe(reads + 1);
  }
  await expectBrowser(explanation).toHaveAttribute("data-changes", "1");
  await expectBrowser(
    page.locator('[role="status"], [aria-live="polite"]').filter({ hasText: ended }),
  ).toHaveCount(1);
  await expectBrowser(confirm).toBeFocused();
  expect(hub.jobs.cancel.calls).toEqual([]);
  // Cancel is gone, so focus goes to the nearest control that remains.
  await page.keyboard.press("Escape");
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(page.getByRole("button", { name: "Delete the job" })).toBeFocused();
});

test("Pause keeps the focus while the hub answers, the other controls wait, and the status then takes it", async ({
  hub,
  open,
}) => {
  const job = runningJob("pause-presser");
  const asked: Job = { ...job, pendingControl: { type: "pause", requestedAt: NOW } };
  hub.jobs.pause.answers(asked);
  const journal = { job, events: [aConversation(1), aStart(2)] };
  const page = await openJob(hub, open, journal);
  // The tab is named by the job's Custom ID.
  await expectBrowser(page).toHaveTitle("Job pause-presser · Elflodge");
  const pause = page.getByRole("button", { name: "Pause", exact: true });
  const sending = hub.jobs.pause.hold();
  await pause.click();
  await sending.arrived;
  await expectBrowser(pause).toHaveAttribute("aria-busy", "true");
  await expectBrowser(pause).toBeFocused();
  // Kept out of the status region's text: the pressed button tells a screen reader it waits.
  await expectBrowser(page.locator("#job-status").getByText("Working…")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  // Cancel waits too, and keeps its place among the controls.
  await expectBrowser(page.getByRole("button", { name: "Cancel the job" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  journal.job = asked;
  sending.release();
  await expectBrowser(page.getByRole("status").filter({ hasText: "Pause asked" })).toBeFocused();
  // Pressed again, it would ask again: it waits until the Runner has paused the job.
  await expectBrowser(pause).toBeDisabled();
  expect(hub.jobs.pause.calls).toEqual([{ id: job.id }]);
});

test("a job read that answers 404 under an open Cancel leaves its not-found page usable", async ({
  hub,
  open,
}) => {
  const job = aJob("gone-under-cancel");
  hub.jobs.list.answers(NO_JOBS_LISTED);
  // Short enough that the not-found page scrolls.
  const page = await openJob(
    hub,
    open,
    { job, events: [] },
    { viewport: { width: 390, height: 200 } },
  );
  await page.getByRole("button", { name: "Cancel the job" }).click();
  const dialog = page.getByRole("alertdialog");
  const link = page.getByRole("main").getByRole("link", { name: "Jobs", exact: true });
  async function expectNothingLeft() {
    await expectBrowser(page.getByRole("heading", { name: "Job not found" })).toBeVisible();
    await expectBrowser(link).toBeFocused();
    await expectBrowser(page.locator('[role="alertdialog"]')).toHaveCount(0);
    await expectBrowser(page.locator("[inert]")).toHaveCount(0);
    const root = page.locator("html");
    await root.evaluate((html) => {
      html.scrollTop = 0;
    });
    await page.mouse.move(100, 100);
    await page.mouse.wheel(0, 100);
    await expect.poll(() => root.evaluate((html) => html.scrollTop)).toBeGreaterThan(0);
  }
  // Deleted elsewhere: the cancel, once answered, finds no job.
  hub.jobs.cancel.refuses("NOT_FOUND");
  const sending = hub.jobs.cancel.hold();
  await dialog.getByRole("button", { name: "Cancel the job" }).click();
  await sending.arrived;
  await expectBrowser(dialog.getByText("Working…")).toBeVisible();
  // Nor does the page's next read of it.
  hub.jobs.get.refuses("NOT_FOUND");
  hub.jobs.events.refuses("NOT_FOUND");
  await page.clock.runFor(5_000);
  await expectNothingLeft();

  const answered = page.waitForResponse((response) =>
    response.url().endsWith(`/jobs/${job.id}/cancel`),
  );
  sending.release();
  await answered;
  await expectNothingLeft();
  await link.click();
  await page.waitForURL("**/dashboard/jobs");
});

test("a refused Cancel shows why in the dialog for a retry, and a 5xx says it may have been done", async ({
  hub,
  open,
}) => {
  const job = aJob("refused-cancel");
  const journal: Journal = { job, events: [] };
  const page = await openJob(hub, open, journal);
  await page.getByRole("button", { name: "Cancel the job" }).click();
  const dialog = page.getByRole("alertdialog");
  const confirm = dialog.getByRole("button", { name: "Cancel the job" });
  hub.jobs.cancel.fails();
  await confirm.click();
  await expectBrowser(dialog.getByRole("alert")).toHaveText(UNCERTAIN);

  const refusal = "Your role does not allow cancelling jobs.";
  hub.jobs.cancel.refuses("FORBIDDEN", { message: refusal });
  await confirm.click();
  await expectBrowser(dialog.getByRole("alert")).toHaveText(refusal);
  await expectBrowser(confirm).toBeFocused();

  const cancelled = aJob("refused-cancel", { status: "cancelled", endedAt: NOW });
  hub.jobs.cancel.answers(cancelled);
  journal.job = cancelled;
  await confirm.click();
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(page.getByRole("status").filter({ hasText: "Cancelled" })).toBeFocused();
  expect(hub.jobs.cancel.calls).toHaveLength(3);
});

/** A job that failed when its model calls' cost reached its budget, and its journal. */
function spentBudget(customId: string): Journal {
  const failure = failedFor("modelBudgetExceeded");
  const job = aJob(customId, {
    status: "failed",
    failure,
    ...STARTED,
    endedAt: ago(30_000),
    modelBudgetUsd: 0.000001,
    usage: { totalTokens: 1200, cost: { totalUsd: 0.000004 } },
  });
  return { job, events: [aConversation(1), aStart(2), aFailure(3, failure)] };
}

test("a member can correct a refused budget and resume the job, which the jobs list then shows", async ({
  hub,
  open,
}) => {
  const journal = spentBudget("budget-spent");
  const { job } = journal;
  const resumed = aJob("budget-spent", { ...STARTED, modelBudgetUsd: 1, usage: job.usage });
  serve(hub, journal);
  hub.batches.get.answers(aBatch("april"));
  const listed = { failure: { reason: "modelBudgetExceeded" as const }, ...STARTED };
  hub.jobs.list.answers({
    jobs: [aListedJob("budget-spent", { status: "failed", ...listed })],
    hasMore: false,
  });
  const page = await open("jobs");
  const jobLink = page.getByRole("link", { name: "budget-spent", exact: true });
  await jobLink.click();
  await expectBrowser(page.getByRole("meter", { name: "Model budget used" })).toHaveAttribute(
    "aria-valuetext",
    / of 0\.000001 USD, estimated$/,
  );
  await expectBrowser(page.getByText("Resume asks for a larger model budget.")).toBeVisible();
  const resume = page.getByRole("button", { name: "Resume", exact: true });
  const dialog = page.getByRole("dialog");
  // As on a browser that leaves focus in place on a mouse press. dispatchEvent("click") would
  // send an untrusted event, which UI SDK handles as a programmatic open.
  await page.getByRole("button", { name: "Delete the job" }).focus();
  await resume.evaluate((button) =>
    button.addEventListener("mousedown", (event: Event) => event.preventDefault(), { once: true }),
  );
  await resume.click();
  await expectBrowser(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expectBrowser(resume).toBeFocused();
  await resume.click();
  const field = dialog.getByLabel("New model budget USD");
  const submit = dialog.getByRole("button", { name: "Resume the job" });
  const hint = await dialog.getByText(/^Cost so far /).innerText();
  await expectBrowser(field).toBeFocused();
  await expectBrowser(field).toHaveAccessibleDescription(hint);

  // A refusal about the job shows in the dialog.
  hub.jobs.resume.refuses("CONFLICT", {
    message:
      "The job's model calls have cost $0.000004, so it resumes only with a modelBudgetUsd above that",
  });
  await field.fill("0.000001");
  await submit.click();
  await expectBrowser(dialog.getByRole("alert")).toContainText(
    "only with a modelBudgetUsd above that",
  );
  await expectBrowser(submit).toBeFocused();
  // So does one about input the form does not hold.
  hub.jobs.resume.refusesInput([{ message: "Invalid ID", path: ["id"] }]);
  await submit.click();
  await expectBrowser(dialog.getByRole("alert")).toHaveText("Invalid ID");
  await expectBrowser(field).not.toHaveAttribute("aria-invalid", "true");
  // One about the budget shows at the field, which keeps what was sent.
  const tooHigh = "Must be at most 5, the hub's maximum";
  hub.jobs.resume.refusesInput([{ message: tooHigh, path: ["modelBudgetUsd"] }]);
  await field.fill("6");
  await submit.click();
  await expectBrowser(field).toBeFocused();
  await expectBrowser(field).toHaveValue("6");
  await expectBrowser(field).toHaveAttribute("aria-invalid", "true");
  await expectBrowser(field).toHaveAccessibleDescription(`${hint} ${tooHigh}`);
  await field.fill("1");
  await expectBrowser(field).not.toHaveAttribute("aria-invalid", "true");
  await expectBrowser(field).toHaveAccessibleDescription(hint);

  // The corrected budget goes. Until the hub answers, the field is read-only, Delete waits, and
  // one "Working…" is announced.
  hub.jobs.resume.answers(resumed);
  const sending = hub.jobs.resume.hold();
  const counts = hub.jobs.counts.hold();
  await submit.click();
  expect(await sending.arrived).toEqual({ id: job.id, modelBudgetUsd: 1 });
  await expectBrowser(field).toHaveJSProperty("readOnly", true);
  await expectBrowser(page.locator('[aria-label="Delete the job"]')).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expectBrowser(dialog.getByRole("status")).toHaveText("Working…");
  expect((await page.locator("body").ariaSnapshot()).match(/Working…/g)).toHaveLength(1);

  // The dialog closes as the resumed job shows, without waiting for the counts it reads again.
  journal.job = resumed;
  hub.jobs.list.answers({
    jobs: [aListedJob("budget-spent", { ...STARTED, modelBudgetUsd: 1 })],
    hasMore: false,
  });
  const countReads = hub.jobs.counts.calls.length;
  sending.release();
  await expect.poll(() => hub.jobs.counts.calls.length).toBeGreaterThan(countReads);
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(page.locator("#job-status")).toBeFocused();
  expect(hub.jobs.resume.calls).toHaveLength(4);
  counts.release();
  // The list read before is out of date, so Back reads it again.
  await page.goBack();
  await expectBrowser(page.getByRole("row").filter({ has: jobLink })).toContainText("Queued");
});

test("a cancelled Batch withdraws Resume while the member is editing the budget", async ({
  hub,
  open,
}) => {
  const journal = spentBudget("budget-withdrawn");
  hub.batches.get.answers(aBatch("april"));
  hub.jobs.resume.answers(journal.job);
  const page = await openJob(hub, open, journal, { hasTouch: true });
  await page.getByRole("button", { name: "Resume", exact: true }).tap();
  const dialog = page.getByRole("dialog", { name: "Resume the job" });
  await expectBrowser(dialog).toBeFocused();
  const field = dialog.getByLabel("New model budget USD");
  await field.fill("2.50");
  const submit = dialog.getByRole("button", { name: "Resume the job" });
  // Another member cancels its Batch, which the page reads every five seconds, while the member
  // is in the field.
  await expectBrowser(field).toBeFocused();
  hub.batches.get.answers(aBatch("april", { status: "cancelled" }));
  await page.clock.runFor(5_000);
  await expectBrowser(
    dialog.getByText("Its Batch was cancelled, so it cannot be resumed."),
  ).toBeVisible();
  await expectBrowser(field).toHaveValue("2.50");
  await expectBrowser(field).toBeFocused();
  await expectBrowser(submit).toBeDisabled();
  await field.press("Enter");
  await page.keyboard.press("Escape");
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(page.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
  await expectBrowser(page.getByRole("button", { name: "Delete the job" })).toBeFocused();
  expect(hub.jobs.resume.calls).toEqual([]);
});

test("a raised budget keeps a member from resending an older amount after a refusal", async ({
  hub,
  open,
}) => {
  const journal = spentBudget("budget-raised");
  hub.batches.get.answers(aBatch("april"));
  const page = await openJob(hub, open, journal);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Resume the job" });
  const field = dialog.getByLabel("New model budget USD");
  await field.fill("1.50");
  const submit = dialog.getByRole("button", { name: "Resume the job" });
  hub.jobs.resume.refuses("CONFLICT", { message: "The job is changing; try again." });
  const sending = hub.jobs.resume.hold();
  await submit.click();
  await sending.arrived;

  // Meanwhile another member resumes it with a budget of 4 USD and pauses it, which the page reads
  // while its own request waits; the hub then refuses that request.
  journal.job = aJob("budget-raised", {
    status: "paused",
    ...STARTED,
    modelBudgetUsd: 4,
    usage: journal.job.usage,
  });
  await page.clock.runFor(5_000);
  const reason = dialog.getByText("Its model budget was raised, so it resumes without a new one.");
  await expectBrowser(reason).toBeVisible();
  sending.release();
  await expectBrowser(dialog.getByRole("alert")).toHaveText("The job is changing; try again.");
  await expectBrowser(reason).toBeVisible();
  await expectBrowser(field).toHaveValue("1.50");
  await expectBrowser(submit).toBeDisabled();

  // The hub would take 1.50, above the cost so far, in place of the raised budget: only the page
  // keeps the member from sending it again.
  hub.jobs.resume.answers(journal.job);
  // Withdrawn, the pressed button keeps focus, marked `aria-disabled` rather than disabled.
  await expectBrowser(submit).toBeFocused();
  await page.keyboard.press("Enter");
  await field.press("Enter");
  await page.keyboard.press("Escape");
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(page.getByRole("button", { name: "Resume", exact: true })).toBeEnabled();
  expect(hub.jobs.resume.calls).toEqual([{ id: journal.job.id, modelBudgetUsd: 1.5 }]);
});

test("a member opening a job sees its success Event and Output together before the next poll", async ({
  hub,
  open,
}) => {
  const journal = { job: runningJob("opening-events"), events: history(1) };
  // The page's first read of the Events is held until the job has succeeded.
  const opening = hub.jobs.events.hold();
  const page = await openJob(hub, open, journal);
  await expectBrowser(statusWord(page)).toHaveText("Running");
  journal.job = succeededJob("opening-events", 17);
  journal.events.push(aSuccess(11, 17));
  opening.release();
  await expectBrowser(page.locator("ol.timeline .ev-id").last()).toHaveText("11");
  await expectBrowser(statusWord(page)).toHaveText("Succeeded");
  await expectBrowser(output(page)).toHaveText("17");
  // That one read of the Events brought them all; the job's own read was the page's first.
  expect(hub.jobs.events.calls).toHaveLength(1);
  expect(hub.jobs.get.calls).toHaveLength(1);
});

test("a member reads the latest hundred Events in journal order, then earlier ones from the same button until reaching the start", async ({
  hub,
  open,
}) => {
  const page = await openJob(hub, open, {
    job: runningJob("earlier-events"),
    events: history(202),
  });
  // With their own numbers, Events 1030 to 2020.
  await expectBrowser(page.locator("ol.timeline .ev-id")).toHaveText(
    Array.from({ length: 100 }, (_, index) => String((index + 103) * 10)),
  );
  const earlier = page.getByRole("button", { name: "Show earlier Events" });
  await earlier.focus();
  const top = await earlier.evaluate((button) => button.getBoundingClientRect().top);
  await page.keyboard.press("Enter");
  const count = page.locator(".tl-head [role=status]");
  await expectBrowser(count).toHaveText("100 earlier Events added. The latest 200 read.");
  await expectBrowser(earlier).toBeFocused();
  expect(await earlier.evaluate((button) => button.getBoundingClientRect().top)).toBeCloseTo(
    top,
    0,
  );
  await page.keyboard.press("Tab");
  await expectBrowser(page.getByRole("button", { name: "Start", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expectBrowser(count).toHaveText("4 earlier Events added. All 204 read.");
  await expectBrowser(
    page.locator(".events-edge-note").filter({ hasText: "There are no earlier Events." }),
  ).toBeFocused();
  await expectBrowser(page.getByRole("button", { name: "Show all 66 lines" })).toBeVisible();
});

test("a member can retry a refused earlier page from its own box", async ({ hub, open }) => {
  const journal = { job: runningJob("retry-earlier"), events: history(102) };
  const page = await openJob(hub, open, journal);
  const earlier = page.getByRole("button", { name: "Show earlier Events" });
  await expectBrowser(earlier).toBeVisible();
  hub.jobs.events.refuses("FORBIDDEN", { message: "Access to these Events was refused." });
  await earlier.click();
  const box = page.locator(".events-edge-note");
  await expectBrowser(box.getByRole("alert")).toHaveText(
    "The earlier Events could not be read: Access to these Events was refused.",
  );
  await expectBrowser(earlier).toBeFocused();

  serve(hub, journal);
  const retry = hub.jobs.events.hold();
  const before = hub.jobs.events.calls.length;
  await page.keyboard.press("Enter");
  await retry.arrived;
  await expectBrowser(earlier).toBeDisabled();
  await expectBrowser(earlier).toHaveAttribute("aria-busy", "true");
  await expectBrowser(earlier).toBeFocused();
  await page.keyboard.press("Enter");
  await expectBrowser(page.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
  await expectBrowser(box.getByRole("alert")).toHaveCount(0);
  retry.release();
  await expectBrowser(box.getByText("There are no earlier Events.", { exact: true })).toBeVisible();
  await expectBrowser(box).toBeFocused();
  expect(hub.jobs.events.calls.slice(before)).toEqual([
    { id: journal.job.id, order: "desc", after: 30, limit: 100 },
  ]);
});

test("following Events resumes automatically after a rate limit", async ({ hub, open }) => {
  const journal = { job: runningJob("transient-events"), events: history(23) };
  const page = await openJob(hub, open, journal);
  await expectBrowser(page.locator(".tl-head [role=status]")).toHaveText("All 25 read");

  const events = (url: URL) => url.pathname.endsWith(`/jobs/${journal.job.id}/events`);
  await page.route(
    events,
    (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/problem+json",
        json: {
          type: "about:blank",
          status: 429,
          title: "Too Many Requests",
        },
      }),
    { times: 1 },
  );
  journal.events.push(aMessage(235));
  const failedRead = page.waitForResponse(
    (response) => events(new URL(response.url())) && response.status() === 429,
  );
  await page.clock.runFor(5_000);
  await failedRead;
  await runClockUntil(page, 1_000, () => page.locator("#event-235").isVisible());
});

test("Latest recovers a refused forward read without dropping the Events already shown", async ({
  hub,
  open,
}) => {
  const journal = { job: runningJob("retry-latest"), events: history(23) };
  const page = await openJob(hub, open, journal);
  const count = page.locator(".tl-head [role=status]");
  await expectBrowser(count).toHaveText("All 25 read");
  // The page follows new Events every five seconds.
  hub.jobs.events.refuses("FORBIDDEN", { message: "Access refused." });
  await page.clock.runFor(5_000);
  await expectBrowser(page.locator(".tl").getByRole("alert")).toContainText("Access refused.");
  await expectBrowser(count).toHaveText("The first 25 read");

  serve(hub, journal);
  journal.events.push(aMessage(235));
  await page.getByRole("button", { name: "Latest", exact: true }).click();
  await expectBrowser(count).toHaveText("All 26 read");
  expect(hub.jobs.events.calls.at(-1)).toMatchObject({ order: "asc", after: 230 });
  await expectBrowser(page.locator(".ev-id").first()).toHaveText("1");
  await expectBrowser(page.locator(".ev-id").last()).toHaveText("235");
});

test("a member can read from the start and page forward in order, to a success shown with its Output", async ({
  hub,
  open,
}) => {
  const journal = { job: runningJob("first-events"), events: history(102) };
  const page = await openJob(hub, open, journal);
  await page.locator("#event-1020").waitFor();
  await page.getByRole("navigation", { name: "Go to" }).getByText("Start", { exact: true }).click();
  const numbers = page.locator("ol.timeline .ev-id");
  await expectBrowser(numbers.first()).toHaveText("1");
  await expectBrowser(numbers.last()).toHaveText("980");
  await expectBrowser(page.getByRole("heading", { name: "Latest activity" })).toBeVisible();
  await expectBrowser(page.locator("#latest")).toHaveCount(0);

  // The job succeeds while the member reads from the start, so the last page carries its success.
  journal.events.push(aSuccess(1030, 17));
  journal.job = succeededJob("first-events", 17);
  const recordsAndErrors = page.getByRole("radio", { name: "Runner’s records and errors" });
  await page.getByText("Runner’s records and errors", { exact: true }).click();
  await page.getByRole("button", { name: "Show later Events" }).click();
  await expectBrowser(recordsAndErrors).toBeChecked();
  // Focus moves to the first Event added that the filter shows, the Runner's record of success.
  await expectBrowser(page.locator("#event-1030")).toBeFocused();
  await expectBrowser(page.locator(".tl-head [role=status]")).toHaveText(
    "5 later Events added. All 105 read.",
  );
  await expectBrowser(numbers.last()).toHaveText("1030");
  await expectBrowser(numbers).toHaveCount(105);
  // With that page, before any later read.
  await expectBrowser(statusWord(page)).toHaveText("Succeeded");
  await expectBrowser(output(page)).toHaveText("17");
});

test("a member paging forward to Events the chosen filter hides keeps the filter, with focus on the timeline", async ({
  hub,
  open,
}) => {
  const journal = { job: runningJob("hidden-events"), events: history(102) };
  const page = await openJob(hub, open, journal);
  await page.locator("#event-1020").waitFor();
  await page.getByRole("navigation", { name: "Go to" }).getByText("Start", { exact: true }).click();
  const numbers = page.locator("ol.timeline .ev-id");
  await expectBrowser(numbers.last()).toHaveText("980");

  // The last page adds only messages, which the Runner's records leave out.
  journal.events.push(aMessage(1030));
  const recordsAndErrors = page.getByRole("radio", { name: "Runner’s records and errors" });
  await page.getByText("Runner’s records and errors", { exact: true }).click();
  await page.getByRole("button", { name: "Show later Events" }).click();
  await expectBrowser(recordsAndErrors).toBeChecked();
  await expectBrowser(page.locator("ol.timeline")).toBeFocused();
  await expectBrowser(page.locator(".tl-head [role=status]")).toHaveText(
    "5 later Events added. All 105 read.",
  );
  await expectBrowser(numbers.last()).toHaveText("1030");
  await expectBrowser(numbers).toHaveCount(105);
});

test("a member reading earlier Events can jump to new ones, and sees the Output when the job succeeds", async ({
  hub,
  open,
}) => {
  const journal = { job: runningJob("live-events"), events: history(25) };
  const page = await openJob(hub, open, journal);
  await page.locator("#latest").evaluate((element) => element.scrollIntoView({ block: "end" }));
  // The page follows new Events every five seconds.
  journal.events.push(aMessage(255));
  await page.clock.runFor(5_000);
  await expectBrowser(page.locator("#event-255")).toBeInViewport();
  // The new Event may be visible while the end of the list is still below the viewport.
  await page.locator("#latest").evaluate((element) => element.scrollIntoView({ block: "center" }));
  await expectBrowser(page.getByRole("button", { name: "Go to them" })).toHaveCount(0);
  const first = page.locator("#event-20");
  await first.evaluate((element) => element.scrollIntoView({ block: "center" }));
  const top = await first.evaluate((element) => element.getBoundingClientRect().top);
  const jobReads = hub.jobs.get.calls.length;

  journal.events.push(aMessage(260), aConversation(264));
  await page.clock.runFor(5_000);
  const notice = page.getByRole("status").filter({ hasText: "2 new Events below" });
  await expectBrowser(notice).toBeVisible();
  await expectBrowser(notice.locator("time")).toHaveCount(0);
  expect(await first.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(
    top,
    0,
  );
  await notice.getByText("Go to them", { exact: true }).click();
  await expectBrowser(page.locator("#event-260")).toBeFocused();

  journal.events.push(aSuccess(267, 17));
  journal.job = succeededJob("live-events", 17);
  await page.clock.runFor(5_000);
  await expectBrowser(page.locator("ol.timeline .ev-id").last()).toHaveText("267");
  await expectBrowser(statusWord(page)).toHaveText("Succeeded");
  await expectBrowser(output(page)).toHaveText("17");
  await expectBrowser(page.locator("#latest, #job-activity")).toHaveCount(0);
  // The Events it follows carry the job, which it does not read on its own.
  expect(hub.jobs.get.calls).toHaveLength(jobReads);
});

test("a member following an ended job sees another member resume it before its next Event", async ({
  hub,
  open,
}) => {
  const failure = failedFor("modelFailed", "Interrupted");
  const failed = aJob("resumed-elsewhere", { status: "failed", failure, ...STARTED, endedAt: NOW });
  const journal = { job: failed, events: [...history(1), aFailure(11, failure)] };
  hub.batches.get.answers(aBatch("april"));
  const page = await openJob(hub, open, journal);
  await expectBrowser(statusWord(page)).toHaveText("Failed");
  await expectBrowser(page.locator(".tl-head [role=status]")).toHaveText("All 4 read");
  journal.job = aJob("resumed-elsewhere", STARTED);
  await page.clock.runFor(5_000);
  await expectBrowser(statusWord(page)).toHaveText("Queued");
  await expectBrowser(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expectBrowser(page.locator("ol.timeline .ev-id").last()).toHaveText("11");
});

test("a member can read a failure reason added by a newer hub on the job and its Event", async ({
  hub,
  open,
}) => {
  // A reason this version of the contract does not name, which its open schema still takes.
  const reason = openFailureSchema.shape.reason.parse(
    "providerUnavailableAfterExhaustingAllConfiguredRecoveryAttempts",
  );
  const failure = { reason, message: "Provider unavailable." };
  const job = aJob("newer-reason", { status: "failed", failure, ...STARTED, endedAt: NOW });
  hub.batches.get.answers(aBatch("april"));
  const page = await openJob(
    hub,
    open,
    { job, events: [...history(1), aFailure(11, failure)] },
    { viewport: { width: 320, height: 780 } },
  );
  const quoted = JSON.stringify(reason);
  const words = `${quoted} (unknown to this dashboard version)`;
  const beside = page.locator(".beside").filter({ hasText: words });
  await expectBrowser(beside.locator("code")).toHaveText(quoted);
  await expectBrowser(beside).toBeVisible();
  const event = page.getByRole("listitem").filter({ has: page.locator("#event-11") });
  const full = event.locator(".ev-body");
  await expectBrowser(full).toBeVisible();
  await expectBrowser(full).toContainText(words);
  const fullReason = full.locator("code.failure-reason");
  await full.scrollIntoViewIfNeeded();
  await expectBrowser(fullReason).toHaveText(quoted);
  await expectBrowser(fullReason).toBeInViewport({ ratio: 1 });
  await expectBrowser(
    full.getByText("(unknown to this dashboard version)", { exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await expectBrowser(full).toContainText("Provider unavailable.");
  await page.getByText("One line each", { exact: true }).click();
  const summary = event.locator(".ev-line");
  await expectBrowser(summary).toBeVisible();
  await summary.scrollIntoViewIfNeeded();
  await expectBrowser(summary.getByText("Unknown failure reason", { exact: true })).toBeInViewport({
    ratio: 1,
  });
  await expectBrowser(summary.locator("[title]")).toHaveAttribute("title", words);
});
