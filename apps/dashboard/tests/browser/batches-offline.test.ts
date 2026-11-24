import { expect, vi } from "vite-plus/test";

import { aBatch } from "../records.ts";
import { setOffline, test, UNCERTAIN } from "./dashboard.tsx";

// Cancelling a Batch offline, in a file of its own, as what the page's libraries hear of the
// network stays with the document.

test("a cancel confirmed offline fails at once and is not sent once back online", async ({
  hub,
  open,
}) => {
  // The stand-in has no answer for the cancel: one that reaches it fails the test.
  const id = "offline-cancel";
  hub.batches.get.answers(aBatch(id));
  const page = await open(`batches/${id}`);
  await page.getByRole("button", { name: `Cancel the Batch ${id}` }).click();
  const dialog = page.getByRole("alertdialog");
  setOffline(true);
  await dialog.getByRole("button", { name: "Cancel the Batch" }).click();
  await expect.element(dialog.getByRole("alert")).toHaveTextContent(UNCERTAIN);

  // Back online, Query would send a cancel it held before it reads the shown Batch again, at the
  // next poll.
  const reads = hub.batches.get.calls.length;
  setOffline(false);
  await vi.advanceTimersByTimeAsync(5_000);
  await expect.poll(() => hub.batches.get.calls.length).toBeGreaterThan(reads);
});
