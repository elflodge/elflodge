import { expect } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser/context";

import { aBatch, aJob, JOB_LIMITS, jobsCounted, NO_JOBS_LISTED } from "../records.ts";
import {
  historyIndex,
  advance,
  descriptionOnFocus,
  isHidden,
  liveRegions,
  test,
} from "./dashboard.tsx";

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
    await page.getByLabelText(label, { exact: label === "Input" }).fill(value);
  const budget = page.getByLabelText("Model budget");
  const timeout = page.getByLabelText("Run timeout");
  const words = descriptionOnFocus(budget);
  await page.getByRole("button", { name: "Submit job" }).click();
  await expect.element(budget).toHaveFocus();
  expect(words).toEqual([
    expect.stringContaining("At most"),
    expect.stringContaining("Must be at most 5, the hub's maximum"),
  ]);
  await expect.element(budget).toHaveAccessibleDescription(/Must be at most 5, the hub's maximum/);
  await expect
    .element(timeout)
    .toHaveAccessibleDescription(/Must be at most 86400, the hub's maximum/);
  // Long enough for a queued polite announcement to reach its region: focus already describes the
  // refusal (ADR 0053).
  await advance(500);
  await expect.element(liveRegions().filter({ hasText: "the hub's maximum" })).toHaveLength(0);
  for (const [label, value] of values)
    await expect
      .element(page.getByLabelText(label, { exact: label === "Input" }))
      .toHaveValue(label === "Model budget" || label === "Run timeout" ? Number(value) : value);

  // An edit ends the refusal at its own field only.
  await budget.fill(".5");
  await expect.element(budget).not.toHaveAttribute("aria-invalid", "true");
  await expect.element(timeout).toHaveAttribute("aria-invalid", "true");
  await timeout.fill("60");
  const job = aJob("invoice-17", { batchId: "invoice-17" });
  hub.batches.create.answers({
    ...aBatch("invoice-17", { jobCounts: jobsCounted({ queued: 1 }) }),
    jobs: [{ created: true, job: { id: job.id, customId: "invoice-17" } }],
  });
  hub.jobs.get.answers(job);
  hub.jobs.events.answers({ events: [], hasMore: false, status: job.status, job });
  await page.getByRole("button", { name: "Submit job" }).click();
  await expect.element(page.getByRole("heading", { level: 1 })).toMatchTextContent("invoice-17");
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
  const input = page.getByLabelText("Input", { exact: true });
  const jobs = page
    .getByRole("navigation", { name: "Where this is" })
    .getByRole("link", { name: "Jobs" });
  const dialog = page.getByRole("alertdialog", { name: "Leave without submitting?" });
  const stay = dialog.getByRole("button", { name: "Stay" });
  await input.fill("Still writing.");
  await jobs.click();
  await expect.element(stay).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => isHidden(dialog)).toBe(true);
  await expect.element(input).toHaveValue("Still writing.");
  await jobs.click();
  await stay.click();
  await expect.poll(() => isHidden(dialog)).toBe(true);
  await expect.element(jobs).toHaveFocus();
  history.back();
  await stay.click();
  await expect.poll(() => isHidden(dialog)).toBe(true);
  await expect.poll(() => location.pathname).toMatch(/\/jobs\/new$/);
  await expect.element(input).toHaveValue("Still writing.");
  const entry = historyIndex();
  await jobs.click();
  await dialog.getByRole("button", { name: "Leave the page" }).click();
  await expect.element(page.getByRole("heading", { name: "Jobs", exact: true })).toBeVisible();
  await expect.poll(() => isHidden(dialog)).toBe(true);
  expect(historyIndex()).toBe(entry + 1);
  await expect.element(page.getByCSS("[inert]")).toHaveLength(0);
  await expect.element(page.getByCSS('[data-slot="alert-dialog-content"]')).toHaveLength(0);
});
