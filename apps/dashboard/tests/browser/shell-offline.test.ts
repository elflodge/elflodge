import { expect, vi } from "vite-plus/test";

import { setOffline, test, texts } from "./dashboard.tsx";

// The hub strip offline, in a file of its own, as what the page's libraries hear of the network
// stays with the document.

test("going offline immediately replaces all the strip's figures with one untimed line", async ({
  open,
}) => {
  const page = await open("change-password");
  const strip = page.getByRole("region", { name: "The hub now" });
  await expect.element(strip.getByText(/ queued$/)).toBeVisible();
  setOffline(true);
  // Once the page has handled the event, with no time passing: what is due now runs, and the clock
  // stays where it is, where a retrying assertion would move it.
  await vi.advanceTimersByTimeAsync(0);
  expect(texts(strip.getByRole("listitem"))).toEqual([
    "The hub cannot be read: this browser is offline.",
  ]);
});
