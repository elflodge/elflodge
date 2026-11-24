import { expect, vi } from "vite-plus/test";
import { commands, userEvent } from "vite-plus/test/browser/context";

import { aBatch } from "../records.ts";
import { focus, test } from "./dashboard.tsx";
import { openJob, spentBudget } from "./journal.ts";

// A test of job.test.ts in a file of its own: a tap needs a browser with touch, which the project
// gives only the files of its touch instance.

test("a cancelled Batch withdraws Resume while the member is editing the budget", async ({
  hub,
  open,
}) => {
  const journal = spentBudget("budget-withdrawn");
  hub.batches.get.answers(aBatch("april"));
  hub.jobs.resume.answers(journal.job);
  const page = await openJob(hub, open, journal);
  await commands.tap(page.getByRole("button", { name: "Resume" }));
  const dialog = page.getByRole("dialog", { name: "Resume the job" });
  await expect.element(dialog).toHaveFocus();
  const field = dialog.getByLabelText("New model budget USD");
  await field.fill("2.50");
  const submit = dialog.getByRole("button", { name: "Resume the job" });
  // Another member cancels its Batch, which the page reads every five seconds, while the member
  // is in the field.
  await expect.element(field).toHaveFocus();
  hub.batches.get.answers(aBatch("april", { status: "cancelled" }));
  await vi.advanceTimersByTimeAsync(5_000);
  await expect
    .element(dialog.getByText("Its Batch was cancelled, so it cannot be resumed."))
    .toBeVisible();
  await expect.element(field).toHaveDisplayValue("2.50");
  await expect.element(field).toHaveFocus();
  await expect.element(submit).toBeDisabled();
  await focus(field);
  await userEvent.keyboard("{Enter}");
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).toHaveLength(0);
  await expect.element(page.getByRole("button", { name: "Resume" })).toHaveLength(0);
  await expect.element(page.getByRole("button", { name: "Delete the job" })).toHaveFocus();
  expect(hub.jobs.resume.calls).toEqual([]);
});
