import { JOB_SUCCEEDED, type JobEvent } from "contract";
import type { Browser } from "playwright";
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

test("a member can finish reading a Cancel confirmation after the job starts", async () => {
  const client = await system.clientWithNewJobsKey();
  const job = await submitJob(client, submission);
  const page = await openAsMember("Job confirmation", `jobs/${job.id}`);
  await page.getByRole("button", { name: "Cancel the job" }).click();
  const dialog = page.getByRole("dialog");
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
  await expectBrowser(page.getByRole("status").filter({ hasText: "Running" })).toBeFocused();
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
  const cancellation = page.getByRole("dialog");
  const confirm = cancellation.getByRole("button", { name: "Cancel the job" });
  try {
    await confirm.click();
    await expectBrowser(confirm).toBeDisabled();
    await expectBrowser(cancellation.getByRole("status")).toHaveText("Working…");
  } finally {
    release.resolve();
  }
  await expectBrowser(
    page
      .getByRole("status")
      .filter({ hasText: "It ended before it started, so it cannot be resumed." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Delete the job" }).click();
  const dialog = page.getByRole("dialog");
  await expectBrowser(dialog.getByRole("button", { name: "Keep it" })).toBeFocused();
  await dialog.getByRole("button", { name: "Delete the job" }).click();
  await expectBrowser(
    page.getByRole("status").filter({ hasText: "Deleted. Its Usage record stays." }),
  ).toBeFocused();
  await expectBrowser(page.getByRole("heading", { name: "This job was deleted" })).toBeVisible({
    timeout: 12_000,
  });
  await expectBrowser(page.getByRole("link", { name: "See the jobs" })).toBeVisible();
}, 30_000);

test("a member can correct a refused budget and resume the job to its Output", async () => {
  const client = await system.clientWithNewJobsKey();
  await system.startRunner();
  onTestFinished(() => system.stopRunner());
  system.model.setResponses([callTool("bash", { command: "true" })]);
  const job = await submitJob(client, { ...submission, modelBudgetUsd: 0.000001 });
  await untilStatus(client, job.id, "failed");
  const page = await openAsMember("Job budget", `jobs/${job.id}`);
  await expectBrowser(page.getByRole("meter", { name: "Model budget used" })).toHaveAttribute(
    "aria-valuetext",
    / of 0\.000001 USD, estimated$/,
  );
  await page.getByText("Resume asks for a larger model budget.").waitFor();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const field = dialog.getByLabel("New model budget (USD)");
  const submit = dialog.getByRole("button", { name: "Resume the job" });
  await field.fill("0.000001");
  await submit.click();
  await expectBrowser(dialog.getByRole("alert")).toContainText(
    "only with a modelBudgetUsd above that",
  );
  await expectBrowser(submit).toBeFocused();
  await field.fill("6");
  await submit.click();
  await expectBrowser(field).toBeFocused();
  await expectBrowser(field).toHaveAttribute("aria-invalid", "true");
  await expectBrowser(field).toHaveAccessibleDescription(/maximum/i);
  system.model.setResponses([callTool("submit_output", { value: 17 })]);
  await field.fill("1");
  await submit.click();
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(page.getByLabel("Output", { exact: true }).locator("code")).toHaveText("17", {
    timeout: 15_000,
  });
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
                text: Array.from({ length: 66 }, (_, i) => `Invoice ${i + 1}`).join("\n"),
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

test("a member opens the latest hundred Events in journal order, with their original numbers", async () => {
  const { id } = await jobWithHistory(102);
  const page = await openAsMember("Newest Events", `jobs/${id}`);
  const numbers = page.locator("ol.timeline .ev-id");
  await expectBrowser(numbers).toHaveText(
    Array.from({ length: 100 }, (_, i) => String((i + 3) * 10)),
  );
}, 30_000);

test("walking back keeps the reader’s place even if they scroll during the read", async () => {
  const { id } = await jobWithHistory(102);
  const page = await openAsMember("Earlier Events", `jobs/${id}`);
  const earlier = page.getByRole("button", { name: "Show earlier Events" });
  await earlier.evaluate((button) => {
    button.scrollIntoView({ block: "center" });
    button.focus({ preventScroll: true });
  });
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route(`**/jobs/${id}/events?*`, async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("order") === "desc" && query.get("after") === "30") {
      requested.resolve();
      await release.promise;
    }
    await route.continue();
  });
  const reading = page.locator("#event-260");
  await page.keyboard.press("Enter");
  let top: number;
  try {
    await requested.promise;
    top = await reading.evaluate((el) => {
      el.scrollIntoView({ block: "center" });
      return el.getBoundingClientRect().top;
    });
  } finally {
    release.resolve();
  }
  await expectBrowser(page.locator("#event-20")).toBeFocused();
  await expectBrowser(page.getByRole("button", { name: "Show all 66 lines" })).toBeVisible();
  const after = await reading.evaluate((el) => el.getBoundingClientRect().top);
  expect(Math.abs(after - top)).toBeLessThan(1);
  await expectBrowser(earlier).toHaveCount(0);
}, 30_000);

test("a member can read from the start and request the next page in order", async () => {
  const { id } = await jobWithHistory(102);
  const page = await openAsMember("First Events", `jobs/${id}`);
  const jumps = page.getByRole("navigation", { name: "Go to" });
  await jumps.getByText("Start", { exact: true }).click();
  const numbers = page.locator("ol.timeline .ev-id");
  await expectBrowser(numbers.first()).toHaveText("1");
  await expectBrowser(numbers.last()).toHaveText("980");
  const recordsAndErrors = page.getByRole("radio", { name: "Runner’s records and errors" });
  await page.getByText("Runner’s records and errors", { exact: true }).click();
  await page.getByRole("button", { name: "Show later Events" }).click();
  await expectBrowser(recordsAndErrors).toBeChecked();
  await expectBrowser(page.locator("#event-2")).toBeFocused();
  await expectBrowser(numbers.last()).toHaveText("1020");
  await expectBrowser(numbers).toHaveCount(104);
}, 30_000);

test("a member reading earlier Events can jump to new ones, and following ends after the final Event", async () => {
  const { id, report } = await jobWithHistory(25);
  const page = await openAsMember("Live Events", `jobs/${id}`);
  await page.locator("#latest").evaluate((el) => el.scrollIntoView({ block: "end" }));
  await report([message(255)]);
  await expectBrowser(page.locator("#event-255")).toBeInViewport({ timeout: 12_000 });
  await expectBrowser(page.getByRole("button", { name: "Go to them" })).toHaveCount(0);
  const first = page.locator("#event-20");
  await first.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const top = await first.evaluate((el) => el.getBoundingClientRect().top);
  const eventsPath = `/jobs/${id}/events`;
  let reads = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === eventsPath) reads++;
  });
  await report([message(260), { id: 264, type: "conversation", record: { id: 264 } }]);
  const notice = page.getByRole("status").filter({ hasText: "2 new Events below" });
  await expectBrowser(notice).toBeVisible({ timeout: 12_000 });
  await expectBrowser(notice).not.toContainText("the latest");
  expect(await first.evaluate((el) => el.getBoundingClientRect().top)).toBeCloseTo(top, 0);
  await notice.getByText("Go to them", { exact: true }).click();
  await expectBrowser(page.locator("#event-260")).toBeFocused();
  await report([
    {
      id: 267,
      type: "entry",
      record: {
        id: 267,
        conversationId: 1,
        kind: JOB_SUCCEEDED,
        data: { timestamp: Date.now(), output: 17 },
      },
    },
  ]);
  await expectBrowser(page.locator("ol.timeline .ev-id").last()).toHaveText("267", {
    timeout: 12_000,
  });
  const finalReads = reads;
  // Two job refreshes cover an entire polling interval, regardless of their phase.
  for (let i = 0; i < 2; i++)
    await page.waitForResponse((response) => new URL(response.url()).pathname === `/jobs/${id}`);
  expect(reads).toBe(finalReads);
}, 45_000);
