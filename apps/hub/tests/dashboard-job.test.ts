import { JOB_FAILED, JOB_SUCCEEDED, problemDetailsSchema, type JobEvent } from "contract";
import type { Browser, Page, Route } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterAll, assert, beforeAll, expect, onTestFinished, test } from "vite-plus/test";

import { launchDashboardBrowser, newMember, signInAt } from "./dashboard-browser.ts";
import {
  protocolClient,
  startedJobReport,
  startSystem,
  submitJob,
  untilStatus,
} from "./harness.ts";
import { callTool, untilAborted } from "./scripted-model.ts";

const system = startSystem({ hubVars: { JOB_MODEL_BUDGET_USD_MAX: "5" } });
let browser: Browser;
const submission = {
  input: "Count the invoices.",
  outputContract: { schema: { type: "integer" } },
};

beforeAll(async () => {
  await system.start();
  browser = await launchDashboardBrowser(system);
});
afterAll(async () => {
  await browser?.close();
  await system.stop();
});

/** pi's entry of a call of `toolName` that ran. */
function toolResult(toolName: string) {
  const ran = { isError: false, durationMs: 5, timestamp: Date.now() };
  return {
    kind: "pi.tool-result",
    model: [{ role: "toolResult", toolCallId: crypto.randomUUID(), toolName, content: [], ...ran }],
  };
}

async function openAsMember(name: string, pathname: string) {
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  await signInAt(system, page, pathname, await newMember(system, name));
  return page;
}

test("a member opens a listed job, sees its pause requested, and finds the paused job in its Batch", async () => {
  const client = await system.clientWithNewJobsKey();
  await system.startRunner();
  onTestFinished(() => system.stopRunner());
  system.model.setResponses([untilAborted]);
  const job = await submitJob(client, { ...submission, customId: "april-invoices" });
  await untilStatus(client, job.id, "running");

  const page = await openAsMember("Job reader", "jobs");
  await page.getByRole("link", { name: "april-invoices" }).click();
  await expectBrowser(page).toHaveTitle("Job april-invoices · Elflodge");
  const pause = page.getByRole("button", { name: "Pause", exact: true });
  await pause.click();
  const status = page.getByRole("status").filter({ hasText: "Pause asked" });
  await expectBrowser(status).toBeFocused();
  await expectBrowser(pause).toBeDisabled();
  await untilStatus(client, job.id, "paused");
  await page.getByRole("link", { name: "its jobs" }).click();
  await expectBrowser(page).toHaveURL(new RegExp(`batchId=${job.batchId}`));
  await expectBrowser(page.getByRole("row").filter({ hasText: "april-invoices" })).toContainText(
    "Paused",
  );
}, 45_000);

test("a member opens a job's tool calls by name, and they stay open as a count grows", async () => {
  const client = await system.clientWithNewJobsKey();
  const job = await submitJob(client, { ...submission, customId: "tool-calls" });
  const runner = await system.connectReportingRunner();
  onTestFinished(() => runner.close());
  const run = await runner.place(job.id);
  const usage = { models: {}, tools: {} };
  // The hub's map lists the shorter name first.
  await runner.start(run, usage, [toolResult("fetch_content"), toolResult("web_search")]);

  const page = await openAsMember("Tool reader", `jobs/${job.id}`);
  await page.getByText("Show tool calls").click();
  const table = page.getByRole("table", { name: "Tool calls by tool" });
  await expectBrowser(table.getByRole("rowheader")).toHaveText(["fetch_content", "web_search"]);
  await expectBrowser(table.getByRole("cell")).toHaveText(["1", "1"]);
  // After the started Event and the two results: a new tool, and another call of one.
  await runner.report(
    { ...run, position: 3 },
    [toolResult("read"), toolResult("web_search")],
    usage,
  );
  await expectBrowser(table.getByRole("rowheader")).toHaveText(
    ["fetch_content", "read", "web_search"],
    { timeout: 15_000 },
  );
  await expectBrowser(table.getByRole("cell")).toHaveText(["1", "1", "2"]);
  await expectBrowser(table).toBeVisible();
}, 45_000);

test("a member can finish reading a Cancel confirmation after the job starts", async () => {
  const client = await system.clientWithNewJobsKey();
  const job = await submitJob(client, submission);
  const page = await openAsMember("Job confirmation", `jobs/${job.id}`);
  const cancel = page.getByRole("button", { name: "Cancel the job" });
  await cancel.click();
  const dialog = page.getByRole("alertdialog");
  await expectBrowser(dialog).toContainText("it has not started");

  system.model.setResponses([untilAborted]);
  await system.startRunner();
  onTestFinished(async () => {
    try {
      await client.jobs.cancel({ id: job.id });
      await untilStatus(client, job.id, "cancelled");
    } finally {
      await system.stopRunner();
    }
  });
  await expectBrowser(dialog).toContainText("Not final: it can be resumed.", { timeout: 15_000 });
  await expectBrowser(dialog.getByRole("button", { name: "Keep it" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expectBrowser(cancel).toBeFocused();
}, 30_000);

test("a member confirms deletion and sees when the job has gone", async () => {
  const client = await system.clientWithNewJobsKey();
  const job = await submitJob(client, { ...submission, customId: "withdrawn-invoices" });
  const page = await openAsMember("Job deletion", `jobs/${job.id.toUpperCase()}`);
  await page.getByRole("button", { name: "Cancel the job" }).click();
  const release = Promise.withResolvers<void>();
  await page.route(`**/jobs/${job.id}/cancel`, async (route) => {
    await release.promise;
    await route.continue();
  });
  const cancellation = page.getByRole("alertdialog");
  const confirm = cancellation.getByRole("button", { name: "Cancel the job" });
  try {
    await confirm.click();
    await expectBrowser(confirm).toBeDisabled();
    await expectBrowser(cancellation.getByText("Working…")).toBeVisible();
  } finally {
    release.resolve();
  }
  await expectBrowser(
    page
      .getByRole("status")
      .filter({ hasText: "It ended before it started, so it cannot be resumed." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Delete the job" }).click();
  const dialog = page.getByRole("alertdialog");
  await expectBrowser(dialog.getByRole("button", { name: "Keep it" })).toBeFocused();
  await dialog.getByRole("button", { name: "Delete the job" }).click();
  await expectBrowser(
    page.getByRole("status").filter({ hasText: "Deleted. Its Usage record stays." }),
  ).toBeFocused();
  await expectBrowser(page.getByRole("heading", { name: "This job was deleted" })).toBeVisible({
    timeout: 12_000,
  });
  await expectBrowser(
    page.getByRole("main").getByRole("link", { name: "Jobs", exact: true }),
  ).toBeVisible();
}, 30_000);

test("an open Delete shows when a resume or another deletion takes it away, and its confirming button does nothing", async () => {
  const { id, report } = await jobWithHistory(1);
  await report([
    {
      id: 11,
      type: "entry",
      record: {
        id: 11,
        conversationId: 1,
        kind: JOB_FAILED,
        data: { timestamp: Date.now(), reason: "modelFailed", message: "Interrupted" },
      },
    },
  ]);
  const page = await openAsMember("Delete withdrawn", `jobs/${id}`);
  const sent = { count: 0 };
  page.on("request", (request) => {
    if (request.method() === "DELETE") sent.count += 1;
  });
  await page.getByRole("button", { name: "Delete the job" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete this job?" });
  const explanation = dialog.locator('[aria-live="polite"]');
  const consequence =
    "Its input, Input files, Events and Output go from the hub now, and from test runner once that Runner has deleted its files. Its Usage record stays.";
  await expectBrowser(explanation).toHaveText(consequence);
  const confirm = dialog.getByRole("button", { name: "Delete the job" });
  await page.keyboard.press("Tab");
  await expectBrowser(confirm).toBeFocused();

  const client = system.owner();
  await client.jobs.resume({ id });
  await expectBrowser(explanation).toHaveText("This job can no longer be deleted.", {
    timeout: 15_000,
  });
  await expectBrowser(confirm).toBeFocused();
  await page.keyboard.press("Enter");
  // Not yet sent again, the resumed job ends at once.
  await client.jobs.cancel({ id });
  await expectBrowser(explanation).toHaveText(consequence, { timeout: 15_000 });
  await client.jobs.delete({ id });
  await expectBrowser(explanation).toHaveText("This job has already been deleted.", {
    timeout: 15_000,
  });
  await expectBrowser(confirm).toBeFocused();
  await page.keyboard.press("Enter");
  await confirm.click({ force: true });
  await page.keyboard.press("Escape");
  await expectBrowser(dialog).toHaveCount(0);
  expect(sent.count).toBe(0);
}, 45_000);

/** A job a Runner has started and still runs, which acts on no control it is sent. */
async function runningJob() {
  const job = await submitJob(system.owner(), submission);
  const runner = await system.connectReportingRunner();
  onTestFinished(() => runner.close());
  const run = await runner.place(job.id);
  await runner.start(run, { models: {}, tools: {} }, []);
  return job;
}

/** Counts the requests the page sends to `path`. */
function countRequests(page: Page, path: string) {
  const sent = { count: 0 };
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === path) sent.count += 1;
  });
  return sent;
}

/** An answer in Problem Details, as the hub gives a refusal or a failure. */
function problemAnswer(status: number, title: string, detail: string) {
  return {
    status,
    contentType: "application/problem+json",
    json: { type: "about:blank", title, status, detail },
  };
}

test("Cancel on a running job asks first, and a stray Enter keeps it running", async () => {
  const job = await runningJob();
  const page = await openAsMember("Stray Enter", `jobs/${job.id}`);
  const sent = countRequests(page, `/jobs/${job.id}/cancel`);
  const cancel = page.getByRole("button", { name: "Cancel the job" });
  await cancel.click();
  const dialog = page.getByRole("alertdialog", { name: "Cancel this job?" });
  await expectBrowser(dialog).toContainText("Not final: it can be resumed.");
  await expectBrowser(dialog.getByRole("button", { name: "Keep it" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(cancel).toBeFocused();
  expect(sent.count).toBe(0);
  expect((await system.owner().jobs.get({ id: job.id })).pendingControl).toBeUndefined();
}, 30_000);

test("a job that ends under an open Cancel changes its polite explanation once, and nothing on the page acts", async () => {
  const job = await submitJob(system.owner(), submission);
  const page = await openAsMember("Ended under Cancel", `jobs/${job.id}`);
  const sent = countRequests(page, `/jobs/${job.id}/cancel`);
  await page.getByRole("button", { name: "Cancel the job" }).click();
  const dialog = page.getByRole("alertdialog");
  const explanation = dialog.locator('[aria-live="polite"]');
  await expectBrowser(explanation).toHaveText(
    "Cancel ends it now. Final: it has not started, so it cannot be resumed.",
  );
  // Counts the batches of mutations inside the polite live node.
  await explanation.evaluate((element) => {
    new element.ownerDocument.defaultView.MutationObserver(() => {
      element.dataset.changes = String(Number(element.dataset.changes ?? 0) + 1);
    }).observe(element, { subtree: true, childList: true, characterData: true });
  });
  const confirm = dialog.getByRole("button", { name: "Cancel the job" });
  await page.keyboard.press("Tab");
  await expectBrowser(confirm).toBeFocused();
  await system.owner().jobs.cancel({ id: job.id });
  const ended = "This job can no longer be cancelled.";
  await expectBrowser(explanation).toHaveText(ended, { timeout: 15_000 });
  await expectBrowser(confirm).toBeFocused();
  // Rendered behind the open dialog, Delete is inert, so it cannot take the dialog over.
  await expectBrowser(page.locator('[inert] [aria-label="Delete the job"]')).toHaveCount(1);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  await confirm.click({ force: true });
  // Two more reads of the job, which change nothing it says.
  for (let read = 0; read < 2; read++) {
    await page.waitForResponse((response) =>
      new URL(response.url()).pathname.startsWith(`/jobs/${job.id}`),
    );
  }
  await expectBrowser(explanation).toHaveAttribute("data-changes", "1");
  await expectBrowser(
    page.locator('[role="status"], [aria-live="polite"]').filter({ hasText: ended }),
  ).toHaveCount(1);
  await expectBrowser(confirm).toBeFocused();
  expect(sent.count).toBe(0);
  // Cancel is gone, so focus goes to the nearest control that remains.
  await page.keyboard.press("Escape");
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(page.getByRole("button", { name: "Delete the job" })).toBeFocused();
}, 45_000);

test("a cancel asked elsewhere while the member's own is sent leaves the hub's answer to decide", async () => {
  const job = await runningJob();
  const page = await openAsMember("Cancelled twice", `jobs/${job.id}`);
  await page.getByRole("button", { name: "Cancel the job" }).click();
  const dialog = page.getByRole("alertdialog");
  const release = Promise.withResolvers<void>();
  await page.route(`**/jobs/${job.id}/cancel`, async (route) => {
    await release.promise;
    await route.continue();
  });
  try {
    await dialog.getByRole("button", { name: "Cancel the job" }).click();
    await expectBrowser(dialog.getByText("Working…")).toBeVisible();
    // The explanation's live region is off while the member's own request runs: its answer decides.
    await expectBrowser(dialog.locator('[data-slot="alert-dialog-description"]')).toHaveAttribute(
      "aria-live",
      "off",
    );
    await system.owner().jobs.cancel({ id: job.id });
    await expectBrowser(dialog).toContainText("Cancel has already been asked.", {
      timeout: 15_000,
    });
    await expectBrowser(dialog.getByText("Working…")).toBeVisible();
  } finally {
    release.resolve();
  }
  // The hub takes a second cancel as the first.
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(page.getByRole("status").filter({ hasText: "Cancel asked" })).toBeFocused();
}, 45_000);

test("Pause keeps the focus while the hub answers, and a second press sends nothing", async () => {
  const job = await runningJob();
  const page = await openAsMember("Pause presser", `jobs/${job.id}`);
  const sent = countRequests(page, `/jobs/${job.id}/pause`);
  const release = Promise.withResolvers<void>();
  await page.route(`**/jobs/${job.id}/pause`, async (route) => {
    await release.promise;
    await route.continue();
  });
  const pause = page.getByRole("button", { name: "Pause", exact: true });
  try {
    await pause.click();
    await expectBrowser(pause).toHaveAttribute("aria-busy", "true");
    await expectBrowser(pause).toBeFocused();
    // Kept out of the status region's text: the pressed button tells a screen reader it waits.
    await expectBrowser(page.locator("#job-status").getByText("Working…")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await pause.click({ force: true });
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    await expectBrowser(pause).toBeFocused();
    // Cancel waits too, and keeps its place among the controls.
    await expectBrowser(page.getByRole("button", { name: "Cancel the job" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  } finally {
    release.resolve();
  }
  await expectBrowser(page.getByRole("status").filter({ hasText: "Pause asked" })).toBeFocused();
  expect(sent.count).toBe(1);
}, 30_000);

test("a Pause a read withdraws while the hub answers keeps the focus until the answer moves it to the status", async () => {
  const job = await submitJob(system.owner(), submission);
  onTestFinished(async () => {
    await system.owner().jobs.cancel({ id: job.id });
  });
  const page = await openAsMember("Withdrawn Pause", `jobs/${job.id}`);
  const release = Promise.withResolvers<void>();
  await page.route(`**/jobs/${job.id}/pause`, async (route) => {
    await release.promise;
    await route.continue();
  });
  const pause = page.getByRole("button", { name: "Pause", exact: true });
  try {
    await pause.click();
    await expectBrowser(pause).toHaveAttribute("aria-busy", "true");
    // Unsent, the job pauses at once.
    await system.owner().jobs.pause({ id: job.id });
    await expectBrowser(page.locator(".status-lg")).toHaveText("Paused", { timeout: 15_000 });
    await expectBrowser(page.getByRole("button", { name: "Resume" })).toBeVisible();
    await expectBrowser(pause).toBeFocused();
  } finally {
    release.resolve();
  }
  await expectBrowser(page.getByRole("status").filter({ hasText: "Paused" })).toBeFocused();
  await expectBrowser(pause).toHaveCount(0);
  await page.getByRole("button", { name: "Resume" }).click();
  await expectBrowser(page.getByRole("status").filter({ hasText: "Queued" })).toBeFocused();
}, 30_000);

test("confirming a Cancel clears an earlier failure as it starts", async () => {
  const job = await submitJob(system.owner(), submission);
  const page = await openAsMember("Failure cleared", `jobs/${job.id}`);
  await page.route(
    `**/jobs/${job.id}/pause`,
    (route) => route.fulfill(problemAnswer(409, "Conflict", "The job is changing; try again.")),
    { times: 1 },
  );
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const failure = page.locator('main [role="alert"]');
  await expectBrowser(failure).toHaveText("Pause: The job is changing; try again.");
  await page.getByRole("button", { name: "Cancel the job" }).click();
  const dialog = page.getByRole("alertdialog");
  const release = Promise.withResolvers<void>();
  await page.route(`**/jobs/${job.id}/cancel`, async (route) => {
    await release.promise;
    await route.continue();
  });
  try {
    await dialog.getByRole("button", { name: "Cancel the job" }).click();
    await expectBrowser(dialog.getByText("Working…")).toBeVisible();
    await expectBrowser(failure).toHaveCount(0);
  } finally {
    release.resolve();
  }
  await expectBrowser(page.getByRole("status").filter({ hasText: "Cancelled" })).toBeFocused();
}, 30_000);

test("a job read that answers 404 under an open Cancel leaves its not-found page usable", async () => {
  const job = await submitJob(system.owner(), submission);
  // Short enough that the not-found page scrolls.
  const page = await browser.newPage({ viewport: { width: 390, height: 200 } });
  onTestFinished(async () => {
    await page.close();
    // Unsent, it would go to the next test's Runner.
    await system.owner().jobs.cancel({ id: job.id });
  });
  await signInAt(system, page, `jobs/${job.id}`, await newMember(system, "Gone under Cancel"));
  await page.getByRole("button", { name: "Cancel the job" }).click();
  const dialog = page.getByRole("alertdialog");
  const gone = problemAnswer(404, "Not Found", "No job with this ID.");
  const release = Promise.withResolvers<void>();
  await page.route(`**/jobs/${job.id}/cancel`, async (route) => {
    await release.promise;
    await route.fulfill(gone);
  });
  const link = page.getByRole("main").getByRole("link", { name: "Jobs", exact: true });
  async function expectNothingLeft() {
    // The page reads the job again every few seconds.
    await expectBrowser(page.getByRole("heading", { name: "Job not found" })).toBeVisible({
      timeout: 15_000,
    });
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
  try {
    await dialog.getByRole("button", { name: "Cancel the job" }).click();
    await expectBrowser(dialog.getByText("Working…")).toBeVisible();
    await page.route(
      (url) => url.pathname === `/jobs/${job.id}` || url.pathname === `/jobs/${job.id}/events`,
      (route) => route.fulfill(gone),
    );
    await expectNothingLeft();
  } finally {
    release.resolve();
  }
  await page.waitForResponse(`**/jobs/${job.id}/cancel`);
  await expectNothingLeft();
  await link.click();
  await page.waitForURL(`${system.origin}/dashboard/jobs`);
}, 45_000);

test("a refused Cancel shows why in the dialog for a retry, and a 5xx says it may have been done", async () => {
  const job = await submitJob(system.owner(), submission);
  const page = await openAsMember("Refused Cancel", `jobs/${job.id}`);
  await page.getByRole("button", { name: "Cancel the job" }).click();
  const dialog = page.getByRole("alertdialog");
  const confirm = dialog.getByRole("button", { name: "Cancel the job" });
  const cancel = `**/jobs/${job.id}/cancel`;
  await page.route(
    cancel,
    (route) => route.fulfill(problemAnswer(503, "Service Unavailable", "Busy.")),
    {
      times: 1,
    },
  );
  await confirm.click();
  await expectBrowser(dialog.getByRole("alert")).toHaveText(
    "The dashboard could not confirm this was done. Check before trying again.",
  );
  await page.route(
    cancel,
    (route) => route.fulfill(problemAnswer(409, "Conflict", "The job is changing; try again.")),
    { times: 1 },
  );
  await confirm.click();
  await expectBrowser(dialog.getByRole("alert")).toHaveText("The job is changing; try again.");
  await expectBrowser(confirm).toBeFocused();
  await confirm.click();
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(page.getByRole("status").filter({ hasText: "Cancelled" })).toBeFocused();
}, 30_000);

async function jobWithSpentBudget() {
  const client = await system.clientWithNewJobsKey();
  await system.startRunner();
  onTestFinished(() => system.stopRunner());
  system.model.setResponses([callTool("bash", { command: "true" })]);
  const job = await submitJob(client, { ...submission, modelBudgetUsd: 0.000001 });
  await untilStatus(client, job.id, "failed");
  return job;
}

test("a member can correct a refused budget and resume the job to its Output", async () => {
  const job = await jobWithSpentBudget();
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  // Keep the cached Jobs list fresh and the hub strip between polls until Resume asks for a read.
  const now = Date.now();
  await page.clock.install({ time: new Date(now) });
  await page.clock.pauseAt(new Date(now + 1_000));
  await signInAt(system, page, "jobs", await newMember(system, "Job budget"));
  const jobLink = page.getByRole("link", { name: job.customId, exact: true });
  await jobLink.click();
  await expectBrowser(page.getByRole("meter", { name: "Model budget used" })).toHaveAttribute(
    "aria-valuetext",
    / of 0\.000001 USD, estimated$/,
  );
  await page.getByText("Resume asks for a larger model budget.").waitFor();
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
  await field.fill("0.000001");
  await submit.click();
  await expectBrowser(dialog.getByRole("alert")).toContainText(
    "only with a modelBudgetUsd above that",
  );
  await expectBrowser(submit).toBeFocused();
  await page.route(
    "**/jobs/*/resume",
    (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/problem+json",
        json: {
          type: "about:blank",
          title: "Bad Request",
          status: 400,
          errors: [{ parameter: "id", detail: "Invalid ID" }],
        },
      }),
    { times: 1 },
  );
  await submit.click();
  await expectBrowser(dialog.getByRole("alert")).toHaveText("Invalid ID");
  await expectBrowser(field).not.toHaveAttribute("aria-invalid", "true");
  await field.fill("6");
  const refused = page.waitForResponse("**/jobs/*/resume");
  await submit.click();
  const problem = problemDetailsSchema.parse(await (await refused).json());
  const issue = problem.errors?.find((entry) => entry.pointer === "/modelBudgetUsd");
  assert.isDefined(issue);
  await expectBrowser(field).toBeFocused();
  await expectBrowser(field).toHaveValue("6");
  await expectBrowser(field).toHaveAttribute("aria-invalid", "true");
  await expectBrowser(field).toHaveAccessibleDescription(`${hint} ${issue.detail}`);
  system.model.setResponses([callTool("submit_output", { value: 17 })]);
  await field.fill("1");
  await expectBrowser(field).not.toHaveAttribute("aria-invalid", "true");
  await expectBrowser(field).toHaveAccessibleDescription(hint);
  const sent = countRequests(page, `/jobs/${job.id}/resume`);
  const release = Promise.withResolvers<void>();
  await page.route("**/jobs/*/resume", async (route) => {
    await release.promise;
    await route.continue();
  });
  const counts = Promise.withResolvers<void>();
  await page.route("**/jobs/counts", async (route) => {
    await counts.promise;
    await route.continue();
  });
  try {
    const sending = page.waitForRequest(`**/jobs/${job.id}/resume`);
    await submit.click();
    await sending;
    await expectBrowser(field).toHaveJSProperty("readOnly", true);
    await expectBrowser(submit).toBeFocused();
    await expectBrowser(submit).toBeDisabled();
    const close = dialog.getByRole("button", { name: "Close" });
    await expectBrowser(close).toBeDisabled();
    await expectBrowser(page.locator('[aria-label="Delete the job"]')).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expectBrowser(dialog.getByRole("status")).toHaveText("Working…");
    expect((await page.locator("body").ariaSnapshot()).match(/Working…/g)).toHaveLength(1);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    await close.click({ force: true });
    await field.press("Enter");
    await expectBrowser(dialog).toBeVisible();
    const reread = page.waitForRequest("**/jobs/counts");
    release.resolve();
    await reread;
    await expectBrowser(dialog).toHaveCount(0);
    await expectBrowser(page.locator("#job-status")).toBeFocused();
    expect(sent.count).toBe(1);
  } finally {
    release.resolve();
    counts.resolve();
  }
  await untilStatus(system.owner(), job.id, "succeeded");
  await page.goBack();
  await expectBrowser(page.getByRole("row").filter({ has: jobLink })).toContainText("Succeeded");
  await jobLink.click();
  await page.clock.resume();
  await expectBrowser(page.getByLabel("Output", { exact: true }).locator("code")).toHaveText("17", {
    timeout: 15_000,
  });
}, 45_000);

test("a cancelled Batch withdraws Resume while the member is editing the budget", async () => {
  const job = await jobWithSpentBudget();
  const page = await browser.newPage({ hasTouch: true });
  onTestFinished(() => page.close());
  await signInAt(system, page, `jobs/${job.id}`, await newMember(system, "Budget withdrawn"));
  const sent = countRequests(page, `/jobs/${job.id}/resume`);
  await page.getByRole("button", { name: "Resume", exact: true }).tap();
  const dialog = page.getByRole("dialog", { name: "Resume the job" });
  await expectBrowser(dialog).toBeFocused();
  const field = dialog.getByLabel("New model budget USD");
  await field.fill("2.50");
  const submit = dialog.getByRole("button", { name: "Resume the job" });
  await submit.focus();
  await system.owner().batches.cancel({ id: job.batchId });
  await expectBrowser(
    dialog.getByText("Its Batch was cancelled, so it cannot be resumed."),
  ).toBeVisible({ timeout: 15_000 });
  await expectBrowser(field).toHaveValue("2.50");
  await expectBrowser(submit).toBeDisabled();
  await expectBrowser(submit).toBeFocused();
  await page.keyboard.press("Enter");
  await field.press("Enter");
  await page.keyboard.press("Escape");
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(page.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
  await expectBrowser(page.getByRole("button", { name: "Delete the job" })).toBeFocused();
  expect(sent.count).toBe(0);
}, 30_000);

test("a raised budget prevents resubmitting an older amount after a refusal", async () => {
  const { id, batchId } = await jobWithSpentBudget();
  const client = system.owner();
  // A resume can queue while its Batch is paused, so the Runner cannot spend the raised budget.
  await client.batches.pause({ id: batchId });
  const page = await openAsMember("Budget raised", `jobs/${id}`);
  const sent = countRequests(page, `/jobs/${id}/resume`);
  const answer = Promise.withResolvers<Route>();
  await page.route(`**/jobs/${id}/resume`, answer.resolve, { times: 1 });
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Resume the job" });
  const field = dialog.getByLabel("New model budget USD");
  await field.fill("1.50");
  const submit = dialog.getByRole("button", { name: "Resume the job" });
  await submit.click();
  const request = await answer.promise;
  await client.jobs.resume({ id, modelBudgetUsd: 4 });
  await client.jobs.pause({ id });
  const reason = dialog.getByText("Its model budget was raised, so it resumes without a new one.");
  await expectBrowser(reason).toBeVisible({ timeout: 15_000 });
  // The trigger that opened the running form stays mounted until its own request settles.
  const trigger = page
    .locator('.job-controls [aria-haspopup="dialog"]')
    .filter({ hasText: "Resume" });
  await expectBrowser(trigger).toBeAttached();
  await request.fulfill(problemAnswer(409, "Conflict", "The job is changing; try again."));
  await expectBrowser(dialog.getByRole("alert")).toHaveText("The job is changing; try again.");
  await expectBrowser(reason).toBeVisible();
  await expectBrowser(trigger).toHaveCount(0);
  await expectBrowser(field).toHaveValue("1.50");
  await expectBrowser(submit).toBeDisabled();
  await expectBrowser(submit).toBeFocused();
  await page.keyboard.press("Enter");
  await field.press("Enter");
  await page.keyboard.press("Escape");
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(page.getByRole("button", { name: "Resume", exact: true })).toBeEnabled();
  expect(sent.count).toBe(1);
}, 45_000);

test("Resume keeps the focus when a poll changes whether it asks for a budget", async () => {
  const { id, batchId } = await jobWithSpentBudget();
  const client = system.owner();
  // A resume queues while its Batch is paused, so the job runs only when the test lets it.
  await client.batches.pause({ id: batchId });
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  // The page polls only when the test moves its clock, so no poll sees the job between states.
  const now = Date.now();
  await page.clock.install({ time: new Date(now) });
  await page.clock.pauseAt(new Date(now + 1_000));
  await signInAt(system, page, `jobs/${id}`, await newMember(system, "Resume focus"));
  const resume = page.getByRole("button", { name: "Resume", exact: true });
  const poll = () => page.clock.runFor(5_000);
  // Just above the cost so far, so one more model call spends it.
  async function raiseBudget() {
    const { usage } = await client.jobs.get({ id });
    await client.jobs.resume({ id, modelBudgetUsd: usage.cost.totalUsd + 0.000001 });
    await client.jobs.pause({ id });
  }

  await expectBrowser(resume).toHaveAttribute("aria-haspopup", "dialog");
  const status = page.locator("#job-status");
  await status.focus();
  await raiseBudget();
  await poll();
  await expectBrowser(resume).not.toHaveAttribute("aria-haspopup");
  await expectBrowser(status).toBeFocused();

  await resume.focus();
  system.model.setResponses([callTool("bash", { command: "true" })]);
  await client.jobs.resume({ id });
  await client.batches.resume({ id: batchId });
  await untilStatus(client, id, "failed");
  await poll();
  await expectBrowser(resume).toHaveAttribute("aria-haspopup", "dialog");
  await expectBrowser(resume).toBeFocused();

  await client.batches.pause({ id: batchId });
  await raiseBudget();
  await poll();
  await expectBrowser(resume).not.toHaveAttribute("aria-haspopup");
  await expectBrowser(resume).toBeFocused();
}, 45_000);

test("a refused direct Resume focuses its failure though a poll changed Resume meanwhile", async () => {
  const { id, batchId } = await jobWithSpentBudget();
  const client = system.owner();
  // A resume queues while its Batch is paused, so the job runs only when the test lets it.
  await client.batches.pause({ id: batchId });
  async function raiseBudget() {
    const { usage } = await client.jobs.get({ id });
    await client.jobs.resume({ id, modelBudgetUsd: usage.cost.totalUsd + 0.000001 });
    await client.jobs.pause({ id });
  }
  await raiseBudget();
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  const now = Date.now();
  await page.clock.install({ time: new Date(now) });
  await page.clock.pauseAt(new Date(now + 1_000));
  await signInAt(system, page, `jobs/${id}`, await newMember(system, "Resume refused"));
  const resume = page.getByRole("button", { name: "Resume", exact: true });
  const poll = () => page.clock.runFor(5_000);
  await expectBrowser(resume).not.toHaveAttribute("aria-haspopup");
  const answer = Promise.withResolvers<Route>();
  await page.route(`**/jobs/${id}/resume`, answer.resolve, { times: 1 });
  await resume.click();
  const request = await answer.promise;
  // Another member resumes the job meanwhile, and it spends its budget.
  system.model.setResponses([callTool("bash", { command: "true" })]);
  await client.jobs.resume({ id });
  await client.batches.resume({ id: batchId });
  await untilStatus(client, id, "failed");
  await poll();
  await expectBrowser(page.locator(".status-lg")).toHaveText("Failed");
  await expectBrowser(resume).toBeFocused();
  await request.fulfill(problemAnswer(409, "Conflict", "The job is changing; try again."));
  const failure = page.locator('main [role="alert"]');
  await expectBrowser(failure).toHaveText("Resume: The job is changing; try again.");
  await expectBrowser(resume).toHaveAttribute("aria-haspopup", "dialog");
  await expectBrowser(failure).toBeFocused();

  // With the failure still shown, a later swap keeps focus on Resume.
  await resume.focus();
  await client.batches.pause({ id: batchId });
  await raiseBudget();
  await poll();
  await expectBrowser(resume).not.toHaveAttribute("aria-haspopup");
  await expectBrowser(resume).toBeFocused();
  await expectBrowser(failure).toBeVisible();
}, 45_000);

function message(id: number): JobEvent {
  return {
    id,
    type: "entry",
    record: {
      id,
      kind: "pi.user",
      conversationId: 1,
      model: [{ role: "user", content: `Invoice ${id}.`, timestamp: Date.now() }],
    },
  };
}

function success(id: number, output: number): JobEvent {
  return {
    id,
    type: "entry",
    record: { id, conversationId: 1, kind: JOB_SUCCEEDED, data: { timestamp: Date.now(), output } },
  };
}

/** The member reads real hub pages. The Runner speaks the protocol so the test can
 * choose the journal length and deliver more Events while the member is reading. */
async function jobWithHistory(entries: number) {
  const { id } = await submitJob(system.owner(), submission);
  const { socket } = await system.connectRunner();
  onTestFinished(() => socket.close(1000));
  const runner = protocolClient(socket);
  const { runs } = await runner.request("sync", { held: [], free: 1 }, 10_000);
  const run = runs.find((placed) => placed.jobId === id);
  assert(run);
  const { runId } = run;
  const held = [{ jobId: id, runId }];
  let position = 0;
  async function report(events: JobEvent[]) {
    const answer = await runner.request(
      "report",
      {
        held,
        free: 0,
        deleted: [],
        jobs: [{ jobId: id, runId, intent: "run", position, events }],
      },
      10_000,
    );
    expect(answer.refused).toEqual([]);
    position = events.at(-1)?.id ?? position;
  }
  const [start] = startedJobReport(run).events;
  assert(start?.type === "entry");
  await report([
    { id: 1, type: "conversation", record: { id: 1 } },
    { ...start, id: 2, record: { ...start.record, id: 2, conversationId: 1 } },
    {
      id: 10,
      type: "entry",
      record: {
        id: 10,
        conversationId: 1,
        kind: "pi.tool-result",
        model: [
          {
            role: "toolResult",
            toolCallId: "list",
            toolName: "bash",
            content: [
              {
                type: "text",
                text: Array.from({ length: 66 }, (_, i) => `Invoice ${i + 1}\n`).join(""),
              },
            ],
            isError: false,
            timestamp: Date.now(),
          },
        ],
      },
    },
    ...Array.from({ length: entries - 1 }, (_, i) => message((i + 2) * 10)),
  ]);
  return { id, report };
}

test("a member opening a job sees its success Event and Output together before the next poll", async () => {
  const { id, report } = await jobWithHistory(1);
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  const opening = Promise.withResolvers<void>();
  const poll = Promise.withResolvers<void>();
  await page.route(
    (url) => url.pathname === `/jobs/${id}/events`,
    async (route) => {
      const newestFirst = new URL(route.request().url()).searchParams.get("order") === "desc";
      await (newestFirst ? opening : poll).promise;
      await route.continue();
    },
  );
  try {
    await signInAt(system, page, `jobs/${id}`, await newMember(system, "Opening Events"));
    await expectBrowser(page.locator(".status-lg")).toHaveText("Running");
    await page.route(
      (url) => url.pathname === `/jobs/${id}`,
      async (route) => {
        await poll.promise;
        await route.continue();
      },
    );
    await report([success(11, 17)]);
    opening.resolve();
    await expectBrowser(page.locator("ol.timeline .ev-id").last()).toHaveText("11");
    await expectBrowser(page.locator(".status-lg")).toHaveText("Succeeded");
    await expectBrowser(page.getByLabel("Output", { exact: true }).locator("code")).toHaveText(
      "17",
    );
  } finally {
    opening.resolve();
    poll.resolve();
  }
}, 30_000);

test("a member opens the latest hundred Events in journal order, with their original numbers", async () => {
  const { id } = await jobWithHistory(102);
  const page = await openAsMember("Newest Events", `jobs/${id}`);
  const numbers = page.locator("ol.timeline .ev-id");
  await expectBrowser(numbers).toHaveText(
    Array.from({ length: 100 }, (_, i) => String((i + 3) * 10)),
  );
}, 30_000);

test("Back returns to the live end after a member follows its Latest activity link", async () => {
  const { id } = await jobWithHistory(25);
  const page = await openAsMember("Live activity", `jobs/${id}`);
  const activity = page.getByRole("heading", { name: "Latest activity" });
  const link = page.getByRole("link", { name: "Latest activity" });
  await page.getByRole("button", { name: "Latest", exact: true }).click();
  await expectBrowser(link).toBeInViewport();
  await link.click();
  await expectBrowser(activity).toBeInViewport();
  await page.goBack();
  await expectBrowser(link).toBeInViewport();
}, 30_000);

test("a member reads earlier Events from the same button until reaching the start", async () => {
  const { id } = await jobWithHistory(202);
  const page = await openAsMember("Earlier Events", `jobs/${id}`);
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
}, 30_000);

test("a member can retry a refused earlier page from its own box", async () => {
  const { id } = await jobWithHistory(102);
  const page = await openAsMember("Retry earlier Events", `jobs/${id}`);
  const earlier = page.getByRole("button", { name: "Show earlier Events" });
  const retry = Promise.withResolvers<void>();
  const earlierPage = (url: URL) =>
    url.pathname.endsWith(`/jobs/${id}/events`) &&
    url.searchParams.get("order") === "desc" &&
    url.searchParams.get("after") === "30";
  await page.route(
    earlierPage,
    (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/problem+json",
        json: {
          type: "about:blank",
          status: 403,
          title: "Forbidden",
          detail: "Access to these Events was refused.",
        },
      }),
    { times: 1 },
  );
  await earlier.click();
  const box = page.locator(".events-edge-note");
  await expectBrowser(box.getByRole("alert")).toHaveText(
    "The earlier Events could not be read: Access to these Events was refused.",
  );
  await expectBrowser(earlier).toBeFocused();
  let requests = 0;
  await page.route(earlierPage, async (route) => {
    requests++;
    await retry.promise;
    await route.continue();
  });
  try {
    await page.keyboard.press("Enter");
    await expectBrowser(earlier).toBeDisabled();
    await expectBrowser(earlier).toHaveAttribute("aria-busy", "true");
    await expectBrowser(earlier).toBeFocused();
    await page.keyboard.press("Enter");
    await expectBrowser(page.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
    await expectBrowser(box.getByRole("alert")).toHaveCount(0);
  } finally {
    retry.resolve();
  }
  await expectBrowser(box.getByText("There are no earlier Events.", { exact: true })).toBeVisible();
  await expectBrowser(box).toBeFocused();
  expect(requests).toBe(1);
}, 30_000);

test("Latest recovers a refused forward read without dropping the Events already shown", async () => {
  const { id, report } = await jobWithHistory(23);
  const page = await openAsMember("Retry Latest", `jobs/${id}`);
  const count = page.locator(".tl-head [role=status]");
  await expectBrowser(count).toHaveText("All 25 read");
  const forward = (url: URL) =>
    url.pathname === `/jobs/${id}/events` && url.searchParams.get("order") === "asc";
  await page.route(forward, (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/problem+json",
      json: { type: "about:blank", title: "Forbidden", status: 403, detail: "Access refused." },
    }),
  );
  await expectBrowser(page.locator(".tl").getByRole("alert")).toContainText("Access refused.", {
    timeout: 12_000,
  });
  await expectBrowser(count).toHaveText("The first 25 read");
  await page.unroute(forward);
  await report([message(235)]);
  const next = page.waitForRequest((request) => forward(new URL(request.url())));
  await page.getByRole("button", { name: "Latest", exact: true }).click();
  expect(new URL((await next).url()).searchParams.get("after")).toBe("230");
  await expectBrowser(count).toHaveText("All 26 read");
  await expectBrowser(page.locator(".ev-id").first()).toHaveText("1");
  await expectBrowser(page.locator(".ev-id").last()).toHaveText("235");
}, 30_000);

test("Latest during catch-up keeps the job from going back to Running after success", async () => {
  const { id, report } = await jobWithHistory(1);
  const page = await openAsMember("Latest during catch-up", `jobs/${id}`);
  await page.locator("#event-10").waitFor();
  const catchUp = Promise.withResolvers<Route>();
  const latest = Promise.withResolvers<Route>();
  await page.route(
    (url) => url.pathname === `/jobs/${id}/events` && url.searchParams.get("after") === "110",
    catchUp.resolve,
    { times: 1 },
  );
  await page.route(
    (url) => url.pathname === `/jobs/${id}/events` && url.searchParams.get("order") === "desc",
    latest.resolve,
  );
  await report(Array.from({ length: 101 }, (_, i) => message(11 + i)));
  const follower = await catchUp.promise;
  await expectBrowser(page.locator("#event-110")).toBeAttached();
  await page.getByRole("button", { name: "Latest", exact: true }).click();
  const jump = await latest.promise;
  // Playwright's request client reaches the same hub through its loopback listener.
  const url = new URL(jump.request().url());
  url.host = system.url().host;
  const running = await jump.fetch({ url: url.href });
  const snapshot = await running.json();
  expect(snapshot.job.status).toBe("running");
  expect(snapshot.events[0].id).toBe(111);

  await report([success(112, 17)]);
  await follower.continue();
  const status = page.locator(".status-lg");
  // If the follower delivered success while Latest was held, the member has seen that end.
  if (await follower.request().response()) await expectBrowser(status).toHaveText("Succeeded");
  const beforeLatest = await status.innerText();
  await jump.fulfill({ response: running });
  await expectBrowser(page.locator(".ev-id").first()).toHaveText("12");
  expect([beforeLatest, await status.innerText()]).not.toEqual(["Succeeded", "Running"]);

  await expectBrowser(page.locator("#event-112")).toBeAttached({ timeout: 12_000 });
  await expectBrowser(status).toHaveText("Succeeded");
  const output = page.getByRole("region", { name: "Output", exact: true });
  await expectBrowser(output.locator("code")).toHaveText("17");
}, 30_000);

test("pausing during a Latest jump keeps the history readable without a failed-read notice", async () => {
  const { id } = await jobWithHistory(102);
  const page = await openAsMember("Pause during Latest", `jobs/${id}`);
  await page.locator("#event-1020").waitFor();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  const later = page.getByRole("button", { name: "Show later Events" });
  await expectBrowser(later).toBeEnabled();
  const latest = (url: URL) =>
    url.pathname === `/jobs/${id}/events` && url.searchParams.get("order") === "desc";
  const release = Promise.withResolvers<void>();
  await page.route(latest, async (route) => {
    await release.promise;
    await route.continue();
  });
  try {
    const request = page.waitForRequest((req) => latest(new URL(req.url())));
    await page.getByRole("button", { name: "Latest", exact: true }).click();
    await request;
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expectBrowser(page.locator(".job-status")).toContainText("Pause asked");
    await expectBrowser(later).toBeEnabled();
    await expectBrowser(page.locator(".ev-id").first()).toHaveText("1");
    await expectBrowser(page.locator(".tl").getByRole("alert")).toHaveCount(0);
  } finally {
    release.resolve();
  }
}, 30_000);

test("a member can read from the start and request the next page in order", async () => {
  const { id, report } = await jobWithHistory(102);
  const page = await openAsMember("First Events", `jobs/${id}`);
  const jumps = page.getByRole("navigation", { name: "Go to" });
  await page.locator("#event-1020").waitFor();
  await report([message(1030)]);
  await expectBrowser(page.locator("#event-1030")).toBeAttached({ timeout: 12_000 });
  await jumps.getByText("Start", { exact: true }).click();
  const numbers = page.locator("ol.timeline .ev-id");
  await expectBrowser(numbers.first()).toHaveText("1");
  await expectBrowser(numbers.last()).toHaveText("980");
  await expectBrowser(page.getByRole("heading", { name: "Latest activity" })).toBeVisible();
  await expectBrowser(page.locator("#latest")).toHaveCount(0);
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
}, 30_000);

test("a member paging forward to a success Event sees its Output before the next poll", async () => {
  const { id, report } = await jobWithHistory(102);
  const page = await openAsMember("Forward to success", `jobs/${id}`);
  await page.locator("#event-1020").waitFor();
  const poll = Promise.withResolvers<void>();
  await page.route(
    (url) =>
      url.pathname === `/jobs/${id}` ||
      (url.pathname === `/jobs/${id}/events` && url.searchParams.get("after") === "1030"),
    async (route) => {
      await poll.promise;
      await route.continue();
    },
  );
  try {
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const later = page.getByRole("button", { name: "Show later Events" });
    await expectBrowser(later).toBeEnabled();
    await report([success(1030, 17)]);
    await later.click();
    await expectBrowser(page.locator(".ev-id").last()).toHaveText("1030");
    await expectBrowser(page.locator(".status-lg")).toHaveText("Succeeded");
    await expectBrowser(page.getByLabel("Output", { exact: true }).locator("code")).toHaveText(
      "17",
    );
  } finally {
    poll.resolve();
  }
}, 30_000);

test("a member reading earlier Events can jump to new ones, and sees the Output when the job succeeds", async () => {
  const { id, report } = await jobWithHistory(25);
  const page = await openAsMember("Live Events", `jobs/${id}`);
  await page.locator("#latest").evaluate((el) => el.scrollIntoView({ block: "end" }));
  await report([message(255)]);
  await expectBrowser(page.locator("#event-255")).toBeInViewport({ timeout: 12_000 });
  // The new Event may be visible while the end of the list is still below the viewport.
  await page.locator("#latest").evaluate((el) => el.scrollIntoView({ block: "center" }));
  await expectBrowser(page.getByRole("button", { name: "Go to them" })).toHaveCount(0);
  const first = page.locator("#event-20");
  await first.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const top = await first.evaluate((el) => el.getBoundingClientRect().top);
  let jobReads = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/jobs/${id}`) jobReads++;
  });
  await report([message(260), { id: 264, type: "conversation", record: { id: 264 } }]);
  const notice = page.getByRole("status").filter({ hasText: "2 new Events below" });
  await expectBrowser(notice).toBeVisible({ timeout: 12_000 });
  await expectBrowser(notice.locator("time")).toHaveCount(0);
  expect(await first.evaluate((el) => el.getBoundingClientRect().top)).toBeCloseTo(top, 0);
  await notice.getByText("Go to them", { exact: true }).click();
  await expectBrowser(page.locator("#event-260")).toBeFocused();
  await report([success(267, 17)]);
  await expectBrowser(page.locator("ol.timeline .ev-id").last()).toHaveText("267", {
    timeout: 12_000,
  });
  await expectBrowser(page.locator(".status-lg")).toHaveText("Succeeded");
  await expectBrowser(page.getByLabel("Output", { exact: true }).locator("code")).toHaveText("17");
  await expectBrowser(page.locator("#latest, #job-activity")).toHaveCount(0);
  expect(jobReads).toBe(0);
}, 45_000);

test("a member keeps reading new Events and gets the Output when an older hub serves the journal", async () => {
  const { id, report } = await jobWithHistory(1);
  const page = await openAsMember("Following during rollout", `jobs/${id}`);
  await page.locator("#event-10").waitFor();
  await page.route(
    (url) => url.pathname === `/jobs/${id}/events` && url.searchParams.get("order") === "asc",
    async (route) => {
      const after = Number(new URL(route.request().url()).searchParams.get("after"));
      const { events, hasMore, status } = await system.owner().jobs.events({ id, after });
      await route.fulfill({ json: { events, hasMore, status } });
    },
  );
  await report([message(11)]);
  await expectBrowser(page.locator("#event-11")).toBeAttached({ timeout: 12_000 });
  await report([success(12, 17)]);
  await expectBrowser(page.locator("#event-12")).toBeAttached({ timeout: 12_000 });
  await expectBrowser(page.locator("#event-11")).toHaveCount(1);
  await expectBrowser(page.getByLabel("Output", { exact: true }).locator("code")).toHaveText("17", {
    timeout: 12_000,
  });
}, 45_000);

test("a member following an ended job sees another member resume it before its next Event", async () => {
  const { id, report } = await jobWithHistory(1);
  await report([
    {
      id: 11,
      type: "entry",
      record: {
        id: 11,
        conversationId: 1,
        kind: JOB_FAILED,
        data: { timestamp: Date.now(), reason: "modelFailed", message: "Interrupted" },
      },
    },
  ]);
  const page = await openAsMember("Resume from elsewhere", `jobs/${id}`);
  await expectBrowser(page.locator(".status-lg")).toHaveText("Failed");
  await expectBrowser(page.locator(".tl-head [role=status]")).toHaveText("All 4 read");
  await system.owner().jobs.resume({ id });
  await expectBrowser(page.locator(".status-lg")).toHaveText("Queued", { timeout: 12_000 });
  await expectBrowser(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expectBrowser(page.locator("ol.timeline .ev-id").last()).toHaveText("11");
}, 30_000);

test("a member can read a failure reason added by a newer hub on the job and its Event", async () => {
  const { id, report } = await jobWithHistory(1);
  await report([
    {
      id: 11,
      type: "entry",
      record: {
        id: 11,
        conversationId: 1,
        kind: JOB_FAILED,
        data: { timestamp: Date.now(), reason: "modelFailed", message: "Provider unavailable." },
      },
    },
  ]);
  const page = await browser.newPage({ viewport: { width: 320, height: 780 } });
  const reason = "providerUnavailableAfterExhaustingAllConfiguredRecoveryAttempts";
  onTestFinished(() => page.close());
  // Serve the seeded job and journal as a hub with one more failure reason would.
  await page.route(
    (url) => url.pathname === `/jobs/${id}` || url.pathname === `/jobs/${id}/events`,
    async (route) => {
      const { pathname, search } = new URL(route.request().url());
      // Only Chromium resolves the member-facing origin to the test hub's loopback port.
      const response = await route.fetch({
        url: new URL(pathname + search, system.url()).href,
        headers: await route.request().allHeaders(),
      });
      const json = await response.json();
      if (pathname.endsWith("/events")) {
        if (json.job) json.job.failure.reason = reason;
        for (const event of json.events) {
          if (event.record.kind === JOB_FAILED) event.record.data.reason = reason;
        }
      } else {
        json.failure.reason = reason;
      }
      await route.fulfill({ response, json });
    },
  );
  await signInAt(system, page, `jobs/${id}`, await newMember(system, "Failure reader"));
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
}, 30_000);
