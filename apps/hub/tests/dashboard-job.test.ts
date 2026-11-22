import { JOB_FAILED, JOB_SUCCEEDED, problemDetailsSchema, type JobEvent } from "contract";
import type { Browser, Route } from "playwright";
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
  await runner.start(run, usage, [toolResult("web_search"), toolResult("bash")]);

  const page = await openAsMember("Tool reader", `jobs/${job.id}`);
  await page.getByText("Show tool calls").click();
  const rows = page.getByRole("table", { name: "Tool calls by tool" }).getByRole("row");
  await expectBrowser(rows).toHaveText([/Tool\s*Calls/, /bash\s*1/, /web_search\s*1/]);
  // The started Event and the two results.
  await runner.report({ ...run, position: 3 }, [toolResult("web_search")], usage);
  await expectBrowser(rows.nth(2)).toHaveText(/web_search\s*2/, { timeout: 15_000 });
  await expectBrowser(rows.nth(2)).toBeVisible();
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
  await expectBrowser(
    page.getByRole("main").getByRole("link", { name: "Jobs", exact: true }),
  ).toBeVisible();
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
  const field = dialog.getByLabel("New model budget USD");
  const submit = dialog.getByRole("button", { name: "Resume the job" });
  const hint = await dialog.getByText(/^Cost so far /).innerText();
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
  await expectBrowser(field).toHaveAttribute("aria-invalid", "true");
  await expectBrowser(field).toHaveAccessibleDescription(`${hint} ${issue.detail}`);
  system.model.setResponses([callTool("submit_output", { value: 17 })]);
  await field.fill("1");
  await expectBrowser(field).not.toHaveAttribute("aria-invalid", "true");
  await expectBrowser(field).toHaveAccessibleDescription(hint);
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
  await page.route(earlierPage, async (route) => {
    await retry.promise;
    await route.continue();
  });
  try {
    await page.keyboard.press("Enter");
    await expectBrowser(earlier).toBeDisabled();
    await expectBrowser(page.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
    await expectBrowser(box.getByRole("alert")).toHaveCount(0);
  } finally {
    retry.resolve();
  }
  await expectBrowser(box.getByText("There are no earlier Events.", { exact: true })).toBeVisible();
  await expectBrowser(box).toBeFocused();
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
