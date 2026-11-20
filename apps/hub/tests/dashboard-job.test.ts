import type { Browser } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterAll, beforeAll, onTestFinished, test } from "vite-plus/test";

import { launchDashboardBrowser, newMember, signInAt } from "./dashboard-browser.ts";
import { startSystem, submitJob, untilStatus } from "./harness.ts";
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
  await expectBrowser(dialog).toContainText("it can be resumed", { timeout: 15_000 });
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
