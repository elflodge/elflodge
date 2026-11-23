import { expect } from "vite-plus/test";

import { InvalidInput } from "../../hub/src/invalid-input.ts";
import { expectBrowser, test } from "./dashboard.ts";
import { aUsageReport, signedIn, TODAY, usageCount } from "./records.ts";

// The Usage page: the report the hub gives for a window, and the form that asks for it. What the
// hub counts and how it groups is the hub's own tests'.

/** A week's report by Batch: two job ends on one day, one of which used nothing. */
function byBatch(costUsd: number) {
  return aUsageReport(
    { from: "2026-11-17", days: { "2026-11-20": usageCount(2, 12_345, costUsd) } },
    {
      groupBy: "batch",
      groups: [
        { batchId: "statements", ...usageCount(1, 12_345, costUsd) },
        { batchId: "receipts", ...usageCount(1) },
      ],
    },
  );
}

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
  await expectBrowser(group.getByRole("rowheader")).toHaveText(["statements", "receipts", "Total"]);
  const daily = page.getByRole("table", { name: "By day" });
  await expectBrowser(daily.locator("tbody time")).toHaveCount(7);
  for (const ledger of [group, daily]) {
    await expectBrowser(ledger.locator("tfoot td.num")).toHaveText(["2", "12,345", "0.1250"]);
  }
  await expectBrowser(
    daily
      .getByRole("row")
      .filter({ has: page.locator("time") })
      .first()
      .locator("td.num"),
  ).toHaveText(["0", "0", "0.0000"]);

  // Read again, the leading cost has grown: the bars take the new scale, and the reader's focus
  // stays where it was.
  hub.usage.get.answers(byBatch(1));
  const meter = group.locator("meter").first();
  await expectBrowser(meter).toHaveAttribute("max", "0.125");
  const link = page.getByRole("link", { name: "statements", exact: true });
  await link.focus();
  await page.getByRole("button", { name: "Show", exact: true }).dispatchEvent("click");
  await expectBrowser(meter).toHaveAttribute("max", "1");
  await expectBrowser(link).toBeFocused();

  // Another grouping asks for the same window.
  hub.usage.get.answers(byStatus);
  await page.getByLabel("Grouped by").selectOption("status");
  await page.getByRole("button", { name: "Show", exact: true }).click();
  const statuses = page.getByRole("table", { name: "By status" });
  await expectBrowser(statuses.getByRole("rowheader")).toHaveText([
    "Succeeded",
    "Cancelled",
    "Total",
  ]);
  expect(hub.usage.get.calls.at(-1)).toMatchObject({ period: "7d", groupBy: "status" });
  await expectBrowser(daily.locator("tbody time")).toHaveCount(7);
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
  await page.getByLabel("Range").selectOption("7d");
  await page.getByLabel("Grouped by").selectOption("label");
  await page.getByLabel("Label key").fill("customer");
  hub.usage.get.answers(byLabel);
  await page.getByRole("button", { name: "Show", exact: true }).click();
  const labels = page.getByRole("table", { name: "By the Label customer" });
  await expectBrowser(labels.getByRole("rowheader")).toHaveText(['"Acme"', "Total"]);
  const asked = { period: "7d", groupBy: "label:customer" };
  expect(hub.usage.get.calls.at(-1)).toMatchObject(asked);

  const calls = hub.usage.get.calls.length;
  await page.reload();
  await expectBrowser(labels.getByRole("rowheader")).toHaveText(['"Acme"', "Total"]);
  await expectBrowser(page.getByLabel("Label key")).toHaveValue("customer");
  await expectBrowser(page.getByLabel("Range")).toHaveValue("7d");
  expect(hub.usage.get.calls.slice(calls)).toMatchObject([asked]);
});

test("a member learns where to read Batch usage without requesting the report", async ({
  hub,
  open,
}) => {
  // The stand-in has no answer for the report: a request for it fails the test.
  hub.session.answers(signedIn("member"));
  const page = await open("change-password");
  await page.getByRole("link", { name: "Usage", exact: true }).click();
  await expectBrowser(
    page.getByText(/Each Batch's page shows what that Batch has used/),
  ).toBeVisible();
  await expectBrowser(page.getByRole("form", { name: "Usage report" })).toHaveCount(0);
  expect(hub.usage.get.calls).toEqual([]);
});

test("west of UTC a job end keeps its UTC weekday, day and year in a cross-year report", async ({
  hub,
  open,
}) => {
  // In Los Angeles the first instant of this UTC day is still Wednesday 31 December 2025.
  const day = "2026-01-01";
  hub.usage.get.answers(
    aUsageReport(
      { from: "2025-10-20", days: { [day]: usageCount(3, 100, 0.01) } },
      { groupBy: "batch", groups: [{ batchId: "new-year", ...usageCount(3, 100, 0.01) }] },
    ),
  );
  const page = await open("usage?period=400d", { timezoneId: "America/Los_Angeles" });
  const daily = page.getByRole("table", { name: "By day" });
  const cell = page.locator(`time[datetime="${day}"]`);
  await expectBrowser(cell).toHaveText("Thu 1 Jan");
  await expectBrowser(
    daily.getByRole("row").filter({ has: cell }).getByRole("cell").first(),
  ).toHaveText("3");
  const bodies = await daily.locator("tbody").all();
  expect(bodies).toHaveLength(2);
  for (const body of bodies) {
    const heading = await body.locator('th[scope="rowgroup"]').innerText();
    const years = await body
      .locator("time")
      .evaluateAll((dates) => dates.map((date) => date.getAttribute("datetime")?.slice(0, 4)));
    expect(new Set(years)).toEqual(new Set([heading]));
  }
});

test("a member can correct a refused range and leave the end open through today", async ({
  hub,
  open,
}) => {
  const week = { from: "2026-11-17", days: { "2026-11-20": usageCount(1, 10, 0.01) } };
  const weekly = () => aUsageReport(week, { groupBy: "batch", groups: [] });
  hub.usage.get.answers(weekly());
  const page = await open("usage?period=7d");
  const days = page.getByRole("table", { name: "By day" }).locator("tbody time");
  await expectBrowser(days).toHaveCount(7);
  await page.getByLabel("Range").selectOption("custom");
  const from = page.getByLabel("From", { exact: true });
  const to = page.getByLabel("To", { exact: true });
  await expectBrowser(from).toHaveValue(week.from);
  await expectBrowser(to).toHaveValue(TODAY);

  // Longer than the hub reads: the browser refuses it, and nothing is asked.
  await from.fill("2000-01-01");
  await to.fill("");
  const show = page.getByRole("button", { name: "Show", exact: true });
  const reads = hub.usage.get.calls.length;
  await show.click();
  await expectBrowser(from).toBeFocused();
  await expectBrowser(from).toHaveJSProperty(
    "validationMessage",
    "Choose at most 400 days, counting both From and To.",
  );
  await expectBrowser(page.getByRole("alert")).toHaveCount(0);
  expect(hub.usage.get.calls).toHaveLength(reads);

  // A start after today, which the hub refuses. The member edits From while it answers, and the
  // edit stays.
  const afterToday = () =>
    hub.usage.get.refuses("BAD_REQUEST", {
      message: "Must not be after today",
      cause: new InvalidInput({
        problems: [{ message: "Must not be after today", path: ["from"] }],
      }),
    });
  afterToday();
  await from.fill("2099-01-01");
  const refusal = hub.usage.get.hold();
  await show.click();
  expect(await refusal.arrived).toMatchObject({ from: "2099-01-01" });
  await from.fill(week.from);
  refusal.release();
  await expectBrowser(from).toHaveAccessibleDescription("Must not be after today");
  await expectBrowser(from).toHaveValue(week.from);
  await expectBrowser(from).toBeFocused();
  await expectBrowser(page.getByRole("alert")).toHaveCount(0);
  // With From hidden, the alert tells the refusal.
  const range = page.getByLabel("Range");
  await range.selectOption("7d");
  await expectBrowser(range).not.toHaveAttribute("aria-invalid", "true");
  await expectBrowser(page.getByRole("alert")).toHaveText("Must not be after today");
  await range.selectOption("custom");
  await expectBrowser(from).toHaveAccessibleDescription("Must not be after today");

  // Without To, the window runs through today.
  hub.usage.get.answers(weekly());
  await from.fill(week.from);
  await show.click();
  await expectBrowser(page.locator(".report-range")).toContainText("(UTC) so far.");
  const read = hub.usage.get.calls.at(-1);
  expect(read).toMatchObject({ from: week.from });
  expect(read).not.toHaveProperty("to");
  await expectBrowser(days).toHaveCount(7);
  await expectBrowser(days.last()).toHaveAttribute("datetime", TODAY);
  expect(new URL(page.url()).searchParams.has("to")).toBe(false);
  afterToday();
  await page.goBack();
  await expectBrowser(from).toHaveValue("2099-01-01");
  hub.usage.get.answers(weekly());
  await page.goForward();
  await expectBrowser(from).toHaveValue(week.from);
});
