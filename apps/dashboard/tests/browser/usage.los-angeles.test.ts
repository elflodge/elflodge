import { expect } from "vite-plus/test";

import { aUsageReport, usageCount } from "../records.ts";
import { innerText, test, texts } from "./dashboard.tsx";

// A test of the Usage page in a file of its own: the time zone is the browser's, which the project
// sets to Los Angeles only for the files of its Los Angeles instance.

test("west of UTC a job end keeps its UTC weekday, day and year in a cross-year report", async ({
  hub,
  open,
}) => {
  // In Los Angeles the first instant of this UTC day is still Wednesday 31 December 2025.
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("America/Los_Angeles");
  const day = "2026-01-01";
  hub.usage.get.answers(
    aUsageReport(
      { from: "2025-10-20", days: { [day]: usageCount(3, 100, 0.01) } },
      { groupBy: "batch", groups: [{ batchId: "new-year", ...usageCount(3, 100, 0.01) }] },
    ),
  );
  const page = await open("usage?period=400d");
  const daily = page.getByRole("table", { name: "By day" });
  const cell = page.getByCSS(`time[datetime="${day}"]`);
  await expect.element(cell).toHaveTextContent("Thu 1 Jan");
  await expect
    .poll(() => texts(daily.getByRole("row").filter({ has: cell }).getByRole("cell").first()))
    .toEqual(["3"]);
  const bodies = daily.getByCSS("tbody").all();
  expect(bodies).toHaveLength(2);
  for (const body of bodies) {
    const heading = await innerText(body.getByCSS('th[scope="rowgroup"]'));
    const years = body
      .getByCSS("time")
      .elements()
      .map((date) => date.getAttribute("datetime")?.slice(0, 4));
    expect(new Set(years)).toEqual(new Set([heading]));
  }
});
