import type { Browser } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterAll, beforeAll, onTestFinished, test } from "vite-plus/test";

import { launchDashboardBrowser, newMember, signInAt } from "../dashboard-browser.ts";
import { startSystem, submitJob, untilStatus } from "../harness.ts";
import { callTool, untilAborted } from "../scripted-model.ts";

// What the hub and a Runner take from the job page: a member's Pause stops the job on its Runner,
// and a Resume carries it on there to its Output.

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

test("a member pauses a listed job, finds it paused in its Batch, and resumes it to its Output", async () => {
  const client = await system.clientWithNewJobsKey();
  await system.startRunner();
  onTestFinished(() => system.stopRunner());
  system.model.setResponses([untilAborted]);
  const job = await submitJob(client, {
    customId: "april-invoices",
    input: "Count the invoices.",
    outputContract: { schema: { type: "integer" } },
  });
  await untilStatus(client, job.id, "running");

  const page = await browser.newPage();
  onTestFinished(() => page.close());
  // Installed first, so the test can move the page's clock to its next poll.
  await page.clock.install();
  await signInAt(system, page, "jobs", await newMember(system, "Job reader"));
  await page.getByRole("link", { name: "april-invoices" }).click();
  await expectBrowser(page).toHaveTitle("Job april-invoices · Elflodge");
  const pause = page.getByRole("button", { name: "Pause", exact: true });
  await pause.click();
  await expectBrowser(page.getByRole("status").filter({ hasText: "Pause asked" })).toBeFocused();
  await expectBrowser(pause).toBeDisabled();
  // The Runner stops the model call in progress and reports the job paused.
  await untilStatus(client, job.id, "paused");
  await page.getByRole("link", { name: "its jobs" }).click();
  await expectBrowser(page).toHaveURL(new RegExp(`batchId=${job.batchId}`));
  const row = page.getByRole("row").filter({ hasText: "april-invoices" });
  await expectBrowser(row).toContainText("Paused");

  // Resumed, the job's next model call gives its Output.
  system.model.setResponses([callTool("submit_output", { value: 17 })]);
  await row.getByRole("link", { name: "april-invoices" }).click();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await untilStatus(client, job.id, "succeeded");
  // The page follows the job's Events every five seconds.
  await page.clock.fastForward(5_000);
  await expectBrowser(page.getByLabel("Output", { exact: true }).locator("code")).toHaveText("17");
}, 45_000);
