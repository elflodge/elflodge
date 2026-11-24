import { expect } from "vite-plus/test";

import { aUsageReport, TODAY, usageCount } from "../records.ts";
import { focus, mountAgain, test, texts } from "./dashboard.tsx";
import { byBatch } from "./usage.ts";

// The Usage page: the report the hub gives for a window, and the form that asks for it. What the
// hub counts and how it groups is the hub's own tests'.

test("an owner sees a range's job ends, tokens and cost by Batch and by day, including empty days", async ({
  hub,
  open,
}) => {
  const byStatus = aUsageReport(
    { from: "2026-11-17", days: { "2026-11-20": usageCount(2, 12_345, 1) } },
    {
      groupBy: "status",
      groups: [
        { status: "succeeded", ...usageCount(1, 12_345, 1) },
        { status: "cancelled", ...usageCount(1) },
      ],
    },
  );
  hub.usage.get.answers(byBatch(0.125));
  const page = await open("usage?period=7d");
  const group = page.getByRole("table", { name: "By Batch" });
  await expect
    .poll(() => texts(group.getByRole("rowheader")))
    .toEqual(["statements", "receipts", "Total"]);
  const daily = page.getByRole("table", { name: "By day" });
  await expect.element(daily.getByCSS("tbody time")).toHaveLength(7);
  for (const ledger of [group, daily]) {
    await expect
      .poll(() => texts(ledger.getByCSS("tfoot td.num")))
      .toEqual(["2", "12,345", "0.1250"]);
  }
  await expect
    .poll(() =>
      texts(
        daily
          .getByRole("row")
          .filter({ has: page.getByCSS("time") })
          .first()
          .getByCSS("td.num"),
      ),
    )
    .toEqual(["0", "0", "0.0000"]);

  // Read again, the leading cost has grown: the bars take the new scale, and the reader's focus
  // stays where it was.
  hub.usage.get.answers(byBatch(1));
  const meter = group.getByCSS("meter").first();
  await expect.element(meter).toHaveAttribute("max", "0.125");
  const link = page.getByRole("link", { name: "statements", exact: true });
  await focus(link);
  // A click that does not move focus, as Playwright's `dispatchEvent` sends it.
  (await page.getByRole("button", { name: "Show", exact: true }).findElement()).dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }),
  );
  await expect.element(meter).toHaveAttribute("max", "1");
  await expect.element(link).toHaveFocus();

  // Another grouping asks for the same window.
  hub.usage.get.answers(byStatus);
  await page.getByLabelText("Grouped by").selectOptions("status");
  await page.getByRole("button", { name: "Show", exact: true }).click();
  const statuses = page.getByRole("table", { name: "By status" });
  await expect
    .poll(() => texts(statuses.getByRole("rowheader")))
    .toEqual(["Succeeded", "Cancelled", "Total"]);
  expect(hub.usage.get.calls.at(-1)).toMatchObject({ period: "7d", groupBy: "status" });
  await expect.element(daily.getByCSS("tbody time")).toHaveLength(7);
});

test("a Label report reopens from its address with the chosen range and key", async ({
  hub,
  open,
}) => {
  const byLabel = aUsageReport(
    { from: "2026-11-17", days: { "2026-11-20": usageCount(2, 12_345, 0.125) } },
    {
      groupBy: "label:customer",
      groups: [{ labelValue: "Acme", ...usageCount(2, 12_345, 0.125) }],
    },
  );
  hub.usage.get.answers(byBatch(0.125));
  const page = await open("usage");
  await page.getByLabelText("Range").selectOptions("7d");
  await page.getByLabelText("Grouped by").selectOptions("label");
  await page.getByLabelText("Label key").fill("customer");
  hub.usage.get.answers(byLabel);
  await page.getByRole("button", { name: "Show", exact: true }).click();
  const labels = page.getByRole("table", { name: "By the Label customer" });
  await expect.poll(() => texts(labels.getByRole("rowheader"))).toEqual(['"Acme"', "Total"]);
  const asked = { period: "7d", groupBy: "label:customer" };
  expect(hub.usage.get.calls.at(-1)).toMatchObject(asked);

  // What a reload keeps is the address: the app mounted again there, with nothing it read before.
  const calls = hub.usage.get.calls.length;
  mountAgain();
  await expect.poll(() => texts(labels.getByRole("rowheader"))).toEqual(['"Acme"', "Total"]);
  await expect.element(page.getByLabelText("Label key")).toHaveValue("customer");
  await expect.element(page.getByLabelText("Range")).toHaveValue("7d");
  expect(hub.usage.get.calls.slice(calls)).toMatchObject([asked]);
});

test("a member can correct a refused range and leave the end open through today", async ({
  hub,
  open,
}) => {
  const week = { from: "2026-11-17", days: { "2026-11-20": usageCount(1, 10, 0.01) } };
  const weekly = () => aUsageReport(week, { groupBy: "batch", groups: [] });
  hub.usage.get.answers(weekly());
  const page = await open("usage?period=7d");
  const days = page.getByRole("table", { name: "By day" }).getByCSS("tbody time");
  await expect.element(days).toHaveLength(7);
  await page.getByLabelText("Range").selectOptions("custom");
  const from = page.getByLabelText("From", { exact: true });
  const to = page.getByLabelText("To", { exact: true });
  await expect.element(from).toHaveValue(week.from);
  await expect.element(to).toHaveValue(TODAY);

  // Longer than the hub reads: the browser refuses it, and nothing is asked.
  await from.fill("2000-01-01");
  await to.fill("");
  const show = page.getByRole("button", { name: "Show", exact: true });
  const reads = hub.usage.get.calls.length;
  await show.click();
  await expect.element(from).toHaveFocus();
  await expect
    .poll(() => validationMessage(from.element()))
    .toBe("Choose at most 400 days, counting both From and To.");
  await expect.element(page.getByRole("alert")).toHaveLength(0);
  expect(hub.usage.get.calls).toHaveLength(reads);

  // A start after today, which the hub refuses. The member edits From while it answers, and the
  // edit stays.
  const afterToday = () =>
    hub.usage.get.refusesInput([{ message: "Must not be after today", path: ["from"] }]);
  afterToday();
  await from.fill("2099-01-01");
  const refusal = hub.usage.get.hold();
  await show.click();
  expect(await refusal.arrived).toMatchObject({ from: "2099-01-01" });
  await from.fill(week.from);
  refusal.release();
  await expect.element(from).toHaveAccessibleDescription("Must not be after today");
  await expect.element(from).toHaveValue(week.from);
  await expect.element(from).toHaveFocus();
  await expect.element(page.getByRole("alert")).toHaveLength(0);
  // With From hidden, the alert tells the refusal.
  const range = page.getByLabelText("Range");
  await range.selectOptions("7d");
  await expect.element(range).not.toHaveAttribute("aria-invalid", "true");
  await expect.element(page.getByRole("alert")).toHaveTextContent("Must not be after today");
  await range.selectOptions("custom");
  await expect.element(from).toHaveAccessibleDescription("Must not be after today");

  // Without To, the window runs through today.
  hub.usage.get.answers(weekly());
  await from.fill(week.from);
  await show.click();
  await expect.element(page.getByCSS(".report-range")).toMatchTextContent("(UTC) so far.");
  const read = hub.usage.get.calls.at(-1);
  expect(read).toMatchObject({ from: week.from });
  expect(read).not.toHaveProperty("to");
  expect(new URL(location.href).searchParams.has("to")).toBe(false);
  afterToday();
  history.back();
  await expect.element(from).toHaveValue("2099-01-01");
  hub.usage.get.answers(weekly());
  history.forward();
  await expect.element(from).toHaveValue(week.from);
});

/** The browser's words for why `element`'s value is refused, as Playwright reads the property. */
function validationMessage(element: Element) {
  return element instanceof HTMLInputElement ? element.validationMessage : undefined;
}
