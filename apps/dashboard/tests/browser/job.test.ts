import { openFailureSchema, type Job } from "contract";
import { expect, vi } from "vite-plus/test";
import { userEvent, utils } from "vite-plus/test/browser/context";

import {
  NOW,
  NO_JOBS_LISTED,
  aBatch,
  aConversation,
  aFailure,
  aJob,
  aListedJob,
  aMessage,
  aStart,
  aSuccess,
  failedFor,
} from "../records.ts";
import {
  focus,
  innerText,
  isVisible,
  runClockUntil,
  test,
  texts,
  UNCERTAIN,
  waitForResponse,
} from "./dashboard.tsx";
import {
  history,
  type Journal,
  openJob,
  output,
  runningJob,
  serve,
  spentBudget,
  STARTED,
  statusWord,
  succeededJob,
} from "./journal.ts";

// The job page: its controls and the confirmations and form they open, and its Events, read a page
// at a time and followed as they arrive.

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
  await expect
    .poll(() => texts(table.getByRole("rowheader")))
    .toEqual(["fetch_content", "web_search"]);
  await expect.poll(() => texts(table.getByRole("cell"))).toEqual(["1", "1"]);

  // By the page's next read, a new tool, and another call of one.
  journal.job = { ...job, toolCalls: { web_search: 2, read: 1, fetch_content: 1 } };
  await vi.advanceTimersByTimeAsync(5_000);
  await expect
    .poll(() => texts(table.getByRole("rowheader")))
    .toEqual(["fetch_content", "read", "web_search"]);
  await expect.poll(() => texts(table.getByRole("cell"))).toEqual(["1", "1", "2"]);
  await expect.element(table).toBeVisible();
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
  await expect.element(confirm).toBeDisabled();
  await expect.element(cancellation.getByText("Working…")).toBeVisible();
  journal.job = cancelled;
  sending.release();
  await expect
    .element(
      page
        .getByRole("status")
        .filter({ hasText: "It ended before it started, so it cannot be resumed." }),
    )
    .toBeVisible();

  await page.getByRole("button", { name: "Delete the job" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Delete the job" }).click();
  await expect
    .element(page.getByRole("status").filter({ hasText: "Deleted. Its Usage record stays." }))
    .toHaveFocus();
  // No Runner holds its files, so the page's next read of it finds none.
  hub.jobs.get.refuses("NOT_FOUND");
  await vi.advanceTimersByTimeAsync(5_000);
  await expect.element(page.getByRole("heading", { name: "This job was deleted" })).toBeVisible();
  await expect.element(page.getByRole("main").getByRole("link", { name: "Jobs" })).toBeVisible();
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
  await expect.element(dialog).toMatchTextContent("Not final: it can be resumed.");
  await expect.element(dialog.getByRole("button", { name: "Keep it" })).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(dialog).toHaveLength(0);
  await expect.element(cancel).toHaveFocus();
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
  const explanation = dialog.getByCSS('[aria-live="polite"]');
  await expect
    .element(explanation)
    .toHaveTextContent("Cancel ends it now. Final: it has not started, so it cannot be resumed.");

  // Its Runner starts it while the member reads; the page reads it every five seconds.
  journal.job = runningJob("ended-under-cancel");
  journal.events = [aConversation(1), aStart(2)];
  await vi.advanceTimersByTimeAsync(5_000);
  await expect
    .element(explanation)
    .toHaveTextContent("Cancel asks test-runner to stop it. Not final: it can be resumed.");
  await expect.element(dialog.getByRole("button", { name: "Keep it" })).toHaveFocus();

  // Counts the batches of mutations inside the polite live node from here on.
  const explained = await explanation.findElement();
  new MutationObserver(() => {
    explained.dataset["changes"] = String(Number(explained.dataset["changes"] ?? 0) + 1);
  }).observe(explained, { subtree: true, childList: true, characterData: true });
  const confirm = dialog.getByRole("button", { name: "Cancel the job" });
  await userEvent.tab();
  await expect.element(confirm).toHaveFocus();
  // Another member cancels it.
  journal.job = { ...journal.job, status: "cancelled", endedAt: NOW };
  await vi.advanceTimersByTimeAsync(5_000);
  const ended = "This job can no longer be cancelled.";
  await expect.element(explanation).toHaveTextContent(ended);
  await expect.element(confirm).toHaveFocus();
  // Rendered behind the open dialog, Delete is inert, so it cannot take the dialog over.
  await expect.element(page.getByCSS('[inert] [aria-label="Delete the job"]')).toHaveLength(1);
  await userEvent.keyboard("{Enter}");
  await userEvent.keyboard("{Space}");
  await confirm.click({ force: true });
  // Two more reads of the job, which change nothing it says.
  for (const read of [1, 2]) {
    const reads = hub.jobs.events.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    await expect
      .poll(() => hub.jobs.events.calls.length, { message: `read ${read}` })
      .toBe(reads + 1);
  }
  await expect.element(explanation).toHaveAttribute("data-changes", "1");
  await expect
    .element(page.getByCSS('[role="status"], [aria-live="polite"]').filter({ hasText: ended }))
    .toHaveLength(1);
  await expect.element(confirm).toHaveFocus();
  expect(hub.jobs.cancel.calls).toEqual([]);
  // Cancel is gone, so focus goes to the nearest control that remains.
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).toHaveLength(0);
  await expect.element(page.getByRole("button", { name: "Delete the job" })).toHaveFocus();
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
  await expect.poll(() => document.title).toBe("Job pause-presser · Elflodge");
  const pause = page.getByRole("button", { name: "Pause" });
  const sending = hub.jobs.pause.hold();
  await pause.click();
  await sending.arrived;
  await expect.element(pause).toHaveAttribute("aria-busy", "true");
  await expect.element(pause).toHaveFocus();
  // Kept out of the status region's text: the pressed button tells a screen reader it waits.
  await expect
    .element(page.getByCSS("#job-status").getByText("Working…"))
    .toHaveAttribute("aria-hidden", "true");
  // Cancel waits too, and keeps its place among the controls.
  await expect
    .element(page.getByRole("button", { name: "Cancel the job" }))
    .toHaveAttribute("aria-disabled", "true");
  journal.job = asked;
  sending.release();
  await expect.element(page.getByRole("status").filter({ hasText: "Pause asked" })).toHaveFocus();
  // Pressed again, it would ask again: it waits until the Runner has paused the job.
  await expect.element(pause).toBeDisabled();
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
  const link = page.getByRole("main").getByRole("link", { name: "Jobs" });
  async function expectNothingLeft() {
    await expect.element(page.getByRole("heading", { name: "Job not found" })).toBeVisible();
    await expect.element(link).toHaveFocus();
    await expect.element(page.getByCSS('[role="alertdialog"]')).toHaveLength(0);
    await expect.element(page.getByCSS("[inert]")).toHaveLength(0);
    const root = document.documentElement;
    root.scrollTop = 0;
    const under = document.elementFromPoint(100, 100);
    if (!under) throw new Error("Nothing at 100, 100");
    await userEvent.wheel(under, { delta: { y: 100 } });
    await expect.poll(() => root.scrollTop).toBeGreaterThan(0);
  }
  // Deleted elsewhere: the cancel, once answered, finds no job.
  hub.jobs.cancel.refuses("NOT_FOUND");
  const sending = hub.jobs.cancel.hold();
  await dialog.getByRole("button", { name: "Cancel the job" }).click();
  await sending.arrived;
  await expect.element(dialog.getByText("Working…")).toBeVisible();
  // Nor does the page's next read of it.
  hub.jobs.get.refuses("NOT_FOUND");
  hub.jobs.events.refuses("NOT_FOUND");
  await vi.advanceTimersByTimeAsync(5_000);
  await expectNothingLeft();

  const answered = waitForResponse((request) => request.url.endsWith(`/jobs/${job.id}/cancel`));
  sending.release();
  await answered;
  await expectNothingLeft();
  await link.click();
  await expect.poll(() => location.href).toBe(`${location.origin}/dashboard/jobs`);
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
  await expect.element(dialog.getByRole("alert")).toHaveTextContent(UNCERTAIN);

  const refusal = "Your role does not allow cancelling jobs.";
  hub.jobs.cancel.refuses("FORBIDDEN", { message: refusal });
  await confirm.click();
  await expect.element(dialog.getByRole("alert")).toHaveTextContent(refusal);
  await expect.element(confirm).toHaveFocus();

  const cancelled = aJob("refused-cancel", { status: "cancelled", endedAt: NOW });
  hub.jobs.cancel.answers(cancelled);
  journal.job = cancelled;
  await confirm.click();
  await expect.element(dialog).toHaveLength(0);
  await expect.element(page.getByRole("status").filter({ hasText: "Cancelled" })).toHaveFocus();
  expect(hub.jobs.cancel.calls).toHaveLength(3);
});

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
  const jobLink = page.getByRole("link", { name: "budget-spent" });
  await jobLink.click();
  await expect
    .element(page.getByRole("meter", { name: "Model budget used" }))
    .toHaveAttribute("aria-valuetext", expect.stringMatching(/ of 0\.000001 USD, estimated$/));
  await expect.element(page.getByText("Resume asks for a larger model budget.")).toBeVisible();
  const resume = page.getByRole("button", { name: "Resume" });
  const dialog = page.getByRole("dialog");
  // As on a browser that leaves focus in place on a mouse press. dispatchEvent("click") would
  // send an untrusted event, which UI SDK handles as a programmatic open.
  await focus(page.getByRole("button", { name: "Delete the job" }));
  (await resume.findElement()).addEventListener("mousedown", (event) => event.preventDefault(), {
    once: true,
  });
  await resume.click();
  await expect.element(dialog).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(resume).toHaveFocus();
  await resume.click();
  const field = dialog.getByLabelText("New model budget USD");
  const submit = dialog.getByRole("button", { name: "Resume the job" });
  const hint = await innerText(dialog.getByText(/^Cost so far /));
  await expect.element(field).toHaveFocus();
  await expect.element(field).toHaveAccessibleDescription(hint);

  // A refusal about the job shows in the dialog.
  hub.jobs.resume.refuses("CONFLICT", {
    message:
      "The job's model calls have cost $0.000004, so it resumes only with a modelBudgetUsd above that",
  });
  await field.fill("0.000001");
  await submit.click();
  await expect
    .element(dialog.getByRole("alert"))
    .toMatchTextContent("only with a modelBudgetUsd above that");
  await expect.element(submit).toHaveFocus();
  // So does one about input the form does not hold.
  hub.jobs.resume.refusesInput([{ message: "Invalid ID", path: ["id"] }]);
  await submit.click();
  await expect.element(dialog.getByRole("alert")).toHaveTextContent("Invalid ID");
  await expect.element(field).not.toHaveAttribute("aria-invalid", "true");
  // One about the budget shows at the field, which keeps what was sent.
  const tooHigh = "Must be at most 5, the hub's maximum";
  hub.jobs.resume.refusesInput([{ message: tooHigh, path: ["modelBudgetUsd"] }]);
  await field.fill("6");
  await submit.click();
  await expect.element(field).toHaveFocus();
  await expect.element(field).toHaveDisplayValue("6");
  await expect.element(field).toHaveAttribute("aria-invalid", "true");
  await expect.element(field).toHaveAccessibleDescription(`${hint} ${tooHigh}`);
  await field.fill("1");
  await expect.element(field).not.toHaveAttribute("aria-invalid", "true");
  await expect.element(field).toHaveAccessibleDescription(hint);

  // The corrected budget goes. Until the hub answers, the field is read-only, Delete waits, and
  // one "Working…" is announced.
  hub.jobs.resume.answers(resumed);
  const sending = hub.jobs.resume.hold();
  const counts = hub.jobs.counts.hold();
  await submit.click();
  expect(await sending.arrived).toEqual({ id: job.id, modelBudgetUsd: 1 });
  await expect
    .poll(async () => {
      const element = await field.findElement();
      return element instanceof HTMLInputElement && element.readOnly;
    })
    .toBe(true);
  await expect
    .element(page.getByCSS('[aria-label="Delete the job"]'))
    .toHaveAttribute("aria-disabled", "true");
  await expect.element(dialog.getByRole("status")).toHaveTextContent("Working…");
  // Once, in what a screen reader reaches of the page.
  const accessible = utils.aria.renderAriaTree(utils.aria.generateAriaTree(document.body));
  expect(accessible.match(/Working…/g)).toHaveLength(1);

  // The dialog closes as the resumed job shows, without waiting for the counts it reads again.
  journal.job = resumed;
  hub.jobs.list.answers({
    jobs: [aListedJob("budget-spent", { ...STARTED, modelBudgetUsd: 1 })],
    hasMore: false,
  });
  const countReads = hub.jobs.counts.calls.length;
  sending.release();
  await expect.poll(() => hub.jobs.counts.calls.length).toBeGreaterThan(countReads);
  await expect.element(dialog).toHaveLength(0);
  await expect.element(page.getByCSS("#job-status")).toHaveFocus();
  expect(hub.jobs.resume.calls).toHaveLength(4);
  counts.release();
  // The list read before is out of date, so Back reads it again.
  window.history.back();
  await expect.element(page.getByRole("row").filter({ has: jobLink })).toMatchTextContent("Queued");
});

test("a raised budget keeps a member from resending an older amount after a refusal", async ({
  hub,
  open,
}) => {
  const journal = spentBudget("budget-raised");
  hub.batches.get.answers(aBatch("april"));
  const page = await openJob(hub, open, journal);
  await page.getByRole("button", { name: "Resume" }).click();
  const dialog = page.getByRole("dialog", { name: "Resume the job" });
  const field = dialog.getByLabelText("New model budget USD");
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
  await vi.advanceTimersByTimeAsync(5_000);
  const reason = dialog.getByText("Its model budget was raised, so it resumes without a new one.");
  await expect.element(reason).toBeVisible();
  sending.release();
  await expect
    .element(dialog.getByRole("alert"))
    .toHaveTextContent("The job is changing; try again.");
  await expect.element(reason).toBeVisible();
  await expect.element(field).toHaveDisplayValue("1.50");
  await expect.element(submit).toBeDisabled();

  // The hub would take 1.50, above the cost so far, in place of the raised budget: only the page
  // keeps the member from sending it again.
  hub.jobs.resume.answers(journal.job);
  // Withdrawn, the pressed button keeps focus, marked `aria-disabled` rather than disabled.
  await expect.element(submit).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await focus(field);
  await userEvent.keyboard("{Enter}");
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).toHaveLength(0);
  await expect.element(page.getByRole("button", { name: "Resume" })).toBeEnabled();
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
  await expect.element(statusWord(page)).toHaveTextContent("Running");
  journal.job = succeededJob("opening-events", 17);
  journal.events.push(aSuccess(11, 17));
  opening.release();
  await expect.element(page.getByCSS("ol.timeline .ev-id").last()).toHaveTextContent("11");
  await expect.element(statusWord(page)).toHaveTextContent("Succeeded");
  await expect.element(output(page)).toHaveTextContent("17");
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
  await expect
    .poll(() => texts(page.getByCSS("ol.timeline .ev-id")))
    .toEqual(Array.from({ length: 100 }, (_, index) => String((index + 103) * 10)));
  const earlier = page.getByRole("button", { name: "Show earlier Events" });
  await focus(earlier);
  const top = (await earlier.findElement()).getBoundingClientRect().top;
  await userEvent.keyboard("{Enter}");
  const count = page.getByCSS(".tl-head [role=status]");
  await expect.element(count).toHaveTextContent("100 earlier Events added. The latest 200 read.");
  await expect.element(earlier).toHaveFocus();
  expect((await earlier.findElement()).getBoundingClientRect().top).toBeCloseTo(top, 0);
  await userEvent.tab();
  await expect.element(page.getByRole("button", { name: "Start" })).toHaveFocus();
  await userEvent.tab({ shift: true });
  await userEvent.keyboard("{Enter}");
  await expect.element(count).toHaveTextContent("4 earlier Events added. All 204 read.");
  await expect
    .element(page.getByCSS(".events-edge-note").filter({ hasText: "There are no earlier Events." }))
    .toHaveFocus();
  await expect.element(page.getByRole("button", { name: "Show all 66 lines" })).toBeVisible();
});

test("a member can retry a refused earlier page from its own box", async ({ hub, open }) => {
  const journal = { job: runningJob("retry-earlier"), events: history(102) };
  const page = await openJob(hub, open, journal);
  const earlier = page.getByRole("button", { name: "Show earlier Events" });
  await expect.element(earlier).toBeVisible();
  hub.jobs.events.refuses("FORBIDDEN", { message: "Access to these Events was refused." });
  await earlier.click();
  const box = page.getByCSS(".events-edge-note");
  await expect
    .element(box.getByRole("alert"))
    .toHaveTextContent("The earlier Events could not be read: Access to these Events was refused.");
  await expect.element(earlier).toHaveFocus();

  serve(hub, journal);
  const retry = hub.jobs.events.hold();
  const before = hub.jobs.events.calls.length;
  await userEvent.keyboard("{Enter}");
  await retry.arrived;
  await expect.element(earlier).toBeDisabled();
  await expect.element(earlier).toHaveAttribute("aria-busy", "true");
  await expect.element(earlier).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("button", { name: "Start" })).toBeDisabled();
  await expect.element(box.getByRole("alert")).toHaveLength(0);
  retry.release();
  await expect.element(box.getByText("There are no earlier Events.")).toBeVisible();
  await expect.element(box).toHaveFocus();
  expect(hub.jobs.events.calls.slice(before)).toEqual([
    { id: journal.job.id, order: "desc", after: 30, limit: 100 },
  ]);
});

test("following Events resumes automatically after a rate limit", async ({ hub, open }) => {
  const journal = { job: runningJob("transient-events"), events: history(23) };
  const page = await openJob(hub, open, journal);
  await expect.element(page.getByCSS(".tl-head [role=status]")).toHaveTextContent("All 25 read");

  // The page follows new Events every five seconds; the next read is refused for its rate.
  hub.jobs.events.rateLimits();
  journal.events.push(aMessage(235));
  const refused = waitForResponse((request) => request.url.includes("/events"));
  await vi.advanceTimersByTimeAsync(5_000);
  expect((await refused).status).toBe(429);
  serve(hub, journal);
  await runClockUntil(1_000, () => isVisible(page.getByCSS("#event-235")));
});

test("Latest recovers a refused forward read without dropping the Events already shown", async ({
  hub,
  open,
}) => {
  const journal = { job: runningJob("retry-latest"), events: history(23) };
  const page = await openJob(hub, open, journal);
  const count = page.getByCSS(".tl-head [role=status]");
  await expect.element(count).toHaveTextContent("All 25 read");
  // The page follows new Events every five seconds.
  hub.jobs.events.refuses("FORBIDDEN", { message: "Access refused." });
  await vi.advanceTimersByTimeAsync(5_000);
  await expect
    .element(page.getByCSS(".tl").getByRole("alert"))
    .toMatchTextContent("Access refused.");
  await expect.element(count).toHaveTextContent("The first 25 read");

  serve(hub, journal);
  journal.events.push(aMessage(235));
  await page.getByRole("button", { name: "Latest" }).click();
  await expect.element(count).toHaveTextContent("All 26 read");
  expect(hub.jobs.events.calls.at(-1)).toMatchObject({ order: "asc", after: 230 });
  await expect.element(page.getByCSS(".ev-id").first()).toHaveTextContent("1");
  await expect.element(page.getByCSS(".ev-id").last()).toHaveTextContent("235");
});

test("a member can read from the start and page forward in order, to a success shown with its Output", async ({
  hub,
  open,
}) => {
  const journal = { job: runningJob("first-events"), events: history(102) };
  const page = await openJob(hub, open, journal);
  await expect.element(page.getByCSS("#event-1020")).toBeVisible();
  await page
    .getByRole("navigation", { name: "Go to a moment of the job" })
    .getByText("Start")
    .click();
  const numbers = page.getByCSS("ol.timeline .ev-id");
  await expect.element(numbers.first()).toHaveTextContent("1");
  await expect.element(numbers.last()).toHaveTextContent("980");
  await expect.element(page.getByRole("heading", { name: "Latest activity" })).toBeVisible();
  await expect.element(page.getByCSS("#latest")).toHaveLength(0);

  // The job succeeds while the member reads from the start, so the last page carries its success.
  journal.events.push(aSuccess(1030, 17));
  journal.job = succeededJob("first-events", 17);
  const recordsAndErrors = page.getByRole("radio", { name: "Runner’s records and errors" });
  await page.getByText("Runner’s records and errors").click();
  await page.getByRole("button", { name: "Show later Events" }).click();
  await expect.element(recordsAndErrors).toBeChecked();
  // Focus moves to the first Event added that the filter shows, the Runner's record of success.
  await expect.element(page.getByCSS("#event-1030")).toHaveFocus();
  await expect
    .element(page.getByCSS(".tl-head [role=status]"))
    .toHaveTextContent("5 later Events added. All 105 read.");
  await expect.element(numbers.last()).toHaveTextContent("1030");
  await expect.element(numbers).toHaveLength(105);
  // With that page, before any later read.
  await expect.element(statusWord(page)).toHaveTextContent("Succeeded");
  await expect.element(output(page)).toHaveTextContent("17");
});

test("a member paging forward to Events the chosen filter hides keeps the filter, with focus on the timeline", async ({
  hub,
  open,
}) => {
  const journal = { job: runningJob("hidden-events"), events: history(102) };
  const page = await openJob(hub, open, journal);
  await expect.element(page.getByCSS("#event-1020")).toBeVisible();
  await page
    .getByRole("navigation", { name: "Go to a moment of the job" })
    .getByText("Start")
    .click();
  const numbers = page.getByCSS("ol.timeline .ev-id");
  await expect.element(numbers.last()).toHaveTextContent("980");

  // The last page adds only messages, which the Runner's records leave out.
  journal.events.push(aMessage(1030));
  const recordsAndErrors = page.getByRole("radio", { name: "Runner’s records and errors" });
  await page.getByText("Runner’s records and errors").click();
  await page.getByRole("button", { name: "Show later Events" }).click();
  await expect.element(recordsAndErrors).toBeChecked();
  await expect.element(page.getByCSS("ol.timeline")).toHaveFocus();
  await expect
    .element(page.getByCSS(".tl-head [role=status]"))
    .toHaveTextContent("5 later Events added. All 105 read.");
  await expect.element(numbers.last()).toHaveTextContent("1030");
  await expect.element(numbers).toHaveLength(105);
});

test("a member reading earlier Events can jump to new ones, and sees the Output when the job succeeds", async ({
  hub,
  open,
}) => {
  const journal = { job: runningJob("live-events"), events: history(25) };
  const page = await openJob(hub, open, journal);
  (await page.getByCSS("#latest").findElement()).scrollIntoView({ block: "end" });
  // The page follows new Events every five seconds.
  journal.events.push(aMessage(255));
  await vi.advanceTimersByTimeAsync(5_000);
  await expect.element(page.getByCSS("#event-255")).toBeInViewport();
  // The page counts it as read once its intersection observer reports the end of the list in view,
  // which an observer reports at the browser's next rendering, in the order they were made: one made
  // now reports after the page's. Before then, scrolling away would leave it unread.
  await new Promise<void>((resolve) => {
    const observer = new IntersectionObserver(() => {
      observer.disconnect();
      resolve();
    });
    observer.observe(document.body);
  });
  // The new Event may be visible while the end of the list is still below the viewport.
  (await page.getByCSS("#latest").findElement()).scrollIntoView({ block: "center" });
  // By part of its name, so a control that offers it under a longer name is absent too.
  await expect
    .element(page.getByRole("button", { name: "Go to them", exact: false }))
    .toHaveLength(0);
  const first = page.getByCSS("#event-20");
  (await first.findElement()).scrollIntoView({ block: "center" });
  const top = (await first.findElement()).getBoundingClientRect().top;
  const jobReads = hub.jobs.get.calls.length;

  journal.events.push(aMessage(260), aConversation(264));
  await vi.advanceTimersByTimeAsync(5_000);
  const notice = page.getByRole("status").filter({ hasText: "2 new Events below" });
  await expect.element(notice).toBeVisible();
  await expect.element(notice.getByCSS("time")).toHaveLength(0);
  expect((await first.findElement()).getBoundingClientRect().top).toBeCloseTo(top, 0);
  await notice.getByText("Go to them").click();
  await expect.element(page.getByCSS("#event-260")).toHaveFocus();

  journal.events.push(aSuccess(267, 17));
  journal.job = succeededJob("live-events", 17);
  await vi.advanceTimersByTimeAsync(5_000);
  await expect.element(page.getByCSS("ol.timeline .ev-id").last()).toHaveTextContent("267");
  await expect.element(statusWord(page)).toHaveTextContent("Succeeded");
  await expect.element(output(page)).toHaveTextContent("17");
  await expect.element(page.getByCSS("#latest, #job-activity")).toHaveLength(0);
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
  await expect.element(statusWord(page)).toHaveTextContent("Failed");
  await expect.element(page.getByCSS(".tl-head [role=status]")).toHaveTextContent("All 4 read");
  journal.job = aJob("resumed-elsewhere", STARTED);
  await vi.advanceTimersByTimeAsync(5_000);
  await expect.element(statusWord(page)).toHaveTextContent("Queued");
  await expect.element(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect.element(page.getByCSS("ol.timeline .ev-id").last()).toHaveTextContent("11");
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
  const beside = page.getByCSS(".beside").filter({ hasText: words });
  await expect.element(beside.getByCSS("code")).toHaveTextContent(quoted);
  await expect.element(beside).toBeVisible();
  const event = page.getByRole("listitem").filter({ has: page.getByCSS("#event-11") });
  const full = event.getByCSS(".ev-body");
  await expect.element(full).toBeVisible();
  await expect.element(full).toMatchTextContent(words);
  const fullReason = full.getByCSS("code.failure-reason");
  (await full.findElement()).scrollIntoView({ block: "center" });
  await expect.element(fullReason).toHaveTextContent(quoted);
  await expect.element(fullReason).toBeInViewport({ ratio: 1 });
  await expect
    .element(full.getByText("(unknown to this dashboard version)"))
    .toBeInViewport({ ratio: 1 });
  await expect.element(full).toMatchTextContent("Provider unavailable.");
  await page.getByText("One line each").click();
  const summary = event.getByCSS(".ev-line");
  await expect.element(summary).toBeVisible();
  (await summary.findElement()).scrollIntoView({ block: "center" });
  await expect.element(summary.getByText("Unknown failure reason")).toBeInViewport({
    ratio: 1,
  });
  await expect.element(summary.getByCSS("[title]")).toHaveAttribute("title", words);
});
