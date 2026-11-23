import { expect } from "vite-plus/test";

import { descriptionOnFocus, expectBrowser, liveRegions, test } from "./dashboard.ts";
import { aBatch, aJob, JOB_LIMITS, jobsCounted, NO_JOBS_LISTED } from "./records.ts";

// Submit a job: the hub's refusals at their fields, and leaving a draft. What the hub does with the
// job is in tests/journeys.

test("a member can correct the limits the hub refused without retyping the job", async ({
  hub,
  open,
}) => {
  hub.jobs.limits.answers(JOB_LIMITS);
  const maxima = [
    { message: "Must be at most 5, the hub's maximum", path: ["agent", "modelBudgetUsd"] },
    { message: "Must be at most 86400, the hub's maximum", path: ["agent", "runTimeoutSeconds"] },
  ];
  hub.batches.create.refusesInput(maxima);
  const page = await open("jobs/new");
  const values = [
    ["Instructions", "Read each invoice."],
    ["Input", "Invoice 17"],
    ["Output schema", '{"type":"integer"}'],
    ["Custom ID", "invoice-17"],
    ["Model budget", "6"],
    ["Run timeout", "90000"],
  ] as const;
  for (const [label, value] of values)
    await page.getByLabel(label, { exact: label === "Input" }).fill(value);
  const budget = page.getByLabel("Model budget");
  const timeout = page.getByLabel("Run timeout");
  const words = await descriptionOnFocus(budget);
  await page.getByRole("button", { name: "Submit job" }).click();
  await expectBrowser(budget).toBeFocused();
  expect(await words.jsonValue()).toEqual([
    expect.stringContaining("At most"),
    expect.stringContaining("Must be at most 5, the hub's maximum"),
  ]);
  await expectBrowser(budget).toHaveAccessibleDescription(/Must be at most 5, the hub's maximum/);
  await expectBrowser(timeout).toHaveAccessibleDescription(
    /Must be at most 86400, the hub's maximum/,
  );
  // Long enough for a queued polite announcement to reach its region: focus already describes the
  // refusal (ADR 0053).
  await page.clock.runFor(500);
  await expectBrowser(liveRegions(page).filter({ hasText: "the hub's maximum" })).toHaveCount(0);
  for (const [label, value] of values)
    await expectBrowser(page.getByLabel(label, { exact: label === "Input" })).toHaveValue(value);

  // An edit ends the refusal at its own field only.
  await budget.fill(".5");
  await expectBrowser(budget).not.toHaveAttribute("aria-invalid", "true");
  await expectBrowser(timeout).toHaveAttribute("aria-invalid", "true");
  await timeout.fill("60");
  const job = aJob("invoice-17", { batchId: "invoice-17" });
  hub.batches.create.answers({
    ...aBatch("invoice-17", { jobCounts: jobsCounted({ queued: 1 }) }),
    jobs: [{ created: true, job: { id: job.id, customId: "invoice-17" } }],
  });
  hub.jobs.get.answers(job);
  hub.jobs.events.answers({ events: [], hasMore: false, status: job.status, job });
  await page.getByRole("button", { name: "Submit job" }).click();
  await expectBrowser(page.getByRole("heading", { level: 1 })).toContainText("invoice-17");
  expect(hub.batches.create.calls.at(-1)).toMatchObject({
    id: "invoice-17",
    agent: {
      instructions: "Read each invoice.",
      outputContract: { schema: { type: "integer" } },
      modelBudgetUsd: 0.5,
      runTimeoutSeconds: 60,
    },
    jobs: [{ customId: "invoice-17", input: "Invoice 17" }],
  });
});

test("a member leaving typed input, by a link or by Back, can stay with the draft or discard it", async ({
  hub,
  open,
}) => {
  hub.jobs.list.answers(NO_JOBS_LISTED);
  hub.jobs.limits.answers(JOB_LIMITS);
  // From the Jobs list, so Back has somewhere to go.
  const page = await open("jobs");
  await page.getByRole("link", { name: "Submit a job", exact: true }).click();
  const input = page.getByLabel("Input", { exact: true });
  const jobs = page
    .getByRole("navigation", { name: "Where this is" })
    .getByRole("link", { name: "Jobs" });
  const dialog = page.getByRole("alertdialog", { name: "Leave without submitting?" });
  const stay = dialog.getByRole("button", { name: "Stay" });
  await input.fill("Still writing.");
  await jobs.click();
  await expectBrowser(stay).toBeFocused();
  await page.keyboard.press("Escape");
  await expectBrowser(dialog).toBeHidden();
  await expectBrowser(input).toHaveValue("Still writing.");
  await jobs.click();
  await stay.click();
  await expectBrowser(dialog).toBeHidden();
  await expectBrowser(jobs).toBeFocused();
  await page.goBack();
  await stay.click();
  await expectBrowser(dialog).toBeHidden();
  await expectBrowser(page).toHaveURL(/\/jobs\/new$/);
  await expectBrowser(input).toHaveValue("Still writing.");
  const entries = await page.evaluate(() => history.length);
  await jobs.click();
  await dialog.getByRole("button", { name: "Leave the page" }).click();
  await expectBrowser(page.getByRole("heading", { name: "Jobs", exact: true })).toBeVisible();
  await expectBrowser(dialog).toBeHidden();
  expect(await page.evaluate(() => history.length)).toBe(entries + 1);
  await expectBrowser(page.locator("[inert]")).toHaveCount(0);
  await expectBrowser(page.locator('[data-slot="alert-dialog-content"]')).toHaveCount(0);
});
