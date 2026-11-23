import { JOB_SUCCEEDED } from "contract";
import type { Browser, Route } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterAll, beforeAll, expect, onTestFinished, test } from "vite-plus/test";

import { launchDashboardBrowser, newMember, signInAt } from "./dashboard-browser.ts";
import { OWNER, protocolClient, startSystem } from "./harness.ts";

const system = startSystem();
let browser: Browser;

beforeAll(async () => {
  await system.start();
  browser = await launchDashboardBrowser(system);
  const owner = system.owner();
  const agent = { outputContract: { schema: { type: "integer" } } };
  for (const id of ["receipts", "statements"]) {
    await owner.batches.create({ id, agent, labels: { customer: "Acme" } });
    const {
      jobs: [added],
    } = await owner.batches.addJobs({
      id,
      jobs: [{ customId: "first", input: "Count the items." }],
    });
    if (!added) throw new Error("The Batch has no job");
    if (id === "receipts") await owner.jobs.cancel({ id: added.job.id });
    else {
      // A Runner reports known figures so the expected ledger is independent of model pricing.
      const { socket } = await system.connectRunner();
      try {
        const runner = protocolClient(socket);
        const {
          runs: [run],
        } = await runner.request("sync", { held: [], free: 1 }, 10_000);
        if (!run) throw new Error("The job was not placed");
        const ref = { jobId: run.jobId, runId: run.runId };
        const report = await runner.request(
          "report",
          {
            held: [ref],
            free: 0,
            deleted: [],
            jobs: [
              {
                ...ref,
                intent: "run",
                position: 0,
                events: [
                  {
                    id: 1,
                    type: "entry",
                    record: { kind: JOB_SUCCEEDED, data: { timestamp: Date.now(), output: 1 } },
                  },
                ],
                usage: {
                  models: { ledger: { totalTokens: 12345, cost: { total: 0.125 } } },
                  tools: {},
                },
              },
            ],
          },
          10_000,
        );
        expect(report.refused).toEqual([]);
      } finally {
        socket.close();
      }
    }
  }
});
afterAll(async () => {
  await browser?.close();
  await system.stop();
});

async function newPage(timezoneId?: string) {
  const page = await browser.newPage({ timezoneId });
  onTestFinished(() => page.close());
  return page;
}

test("an owner sees a range's job ends, tokens and cost by Batch and by day, including empty days", async () => {
  const page = await newPage();
  await signInAt(system, page, "usage", OWNER);
  const group = page.getByRole("table", { name: "By Batch" });
  await expectBrowser(group.getByRole("rowheader")).toHaveText(["statements", "receipts", "Total"]);
  const daily = page.getByRole("table", { name: "By day" });
  await expectBrowser(daily.locator("tbody time")).toHaveCount(30);
  const figures = ["2", "12,345", "0.1250"];
  for (const ledger of [group, daily]) {
    await expectBrowser(ledger.locator("tfoot td.num")).toHaveText(figures);
  }
  await expectBrowser(
    daily
      .getByRole("row")
      .filter({ has: page.locator("time") })
      .first()
      .locator("td.num"),
  ).toHaveText(["0", "0", "0.0000"]);
}, 30_000);

test("refreshing a usage report rescales its bars when the leading cost changes", async () => {
  const page = await newPage();
  await signInAt(system, page, "usage", OWNER);
  const meter = page.getByRole("table", { name: "By Batch" }).locator("meter").first();
  await expectBrowser(meter).toHaveAttribute("max", "0.125");
  const updated = await system.owner().usage.get({ groupBy: "batch" });
  if (updated.groupBy !== "batch") throw new Error("Expected a ranked Batch");
  for (const row of [updated, ...updated.days, ...updated.groups, updated.other]) {
    row.usage.cost.totalUsd *= 8;
  }
  await page.route(
    (url) => url.pathname === "/usage",
    (route) => route.fulfill({ json: updated }),
    { times: 1 },
  );
  const link = page.getByRole("link", { name: "statements", exact: true });
  await link.focus();
  // Refresh without moving focus to the button.
  await page.getByRole("button", { name: "Show", exact: true }).dispatchEvent("click");
  await expectBrowser(meter).toHaveAttribute("max", "1");
  await expectBrowser(link).toBeFocused();
}, 30_000);

test("changing the grouping keeps the window and totals", async () => {
  const page = await newPage();
  await signInAt(system, page, "usage?period=7d", OWNER);
  const batchTotal = page.getByRole("table", { name: "By Batch" }).locator("tfoot td.num");
  await expectBrowser(batchTotal).toHaveCount(3);
  const total = await batchTotal.allTextContents();
  await page.getByLabel("Grouped by").selectOption("status");
  await page.getByRole("button", { name: "Show", exact: true }).click();
  const statuses = page.getByRole("table", { name: "By status" });
  await expectBrowser(statuses.getByRole("rowheader")).toHaveText([
    "Succeeded",
    "Cancelled",
    "Total",
  ]);
  await expectBrowser(statuses.locator("tfoot td.num")).toHaveText(total);
  await expectBrowser(
    page.getByRole("table", { name: "By day" }).locator("tbody time"),
  ).toHaveCount(7);
}, 30_000);

test("a Label report reopens from its address with the chosen range and key", async () => {
  const page = await newPage();
  await signInAt(system, page, "usage", OWNER);
  await page.getByLabel("Range").selectOption("7d");
  await page.getByLabel("Grouped by").selectOption("label");
  await page.getByLabel("Label key").fill("customer");
  await page.getByRole("button", { name: "Show", exact: true }).click();
  const labels = page.getByRole("table", { name: "By the Label customer" });
  await expectBrowser(labels.getByRole("rowheader")).toHaveText(['"Acme"', "Total"]);
  await page.reload();
  await expectBrowser(labels.getByRole("rowheader")).toHaveText(['"Acme"', "Total"]);
  await expectBrowser(page.getByLabel("Label key")).toHaveValue("customer");
  await expectBrowser(page.getByLabel("Range")).toHaveValue("7d");
}, 30_000);

test("a member learns where to read Batch usage without requesting the report", async () => {
  const page = await newPage();
  const reads: string[] = [];
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === "/usage") reads.push(req.url());
  });
  await signInAt(system, page, "change-password", await newMember(system, "Usage reader"));
  await page.getByRole("link", { name: "Usage", exact: true }).click();
  await expectBrowser(
    page.getByText(/Each Batch's page shows what that Batch has used/),
  ).toBeVisible();
  await expectBrowser(page.getByRole("form", { name: "Usage report" })).toHaveCount(0);
  expect(reads).toEqual([]);
}, 30_000);

test("an admin who loses the role sees the member page on the next Usage read", async () => {
  const page = await newPage();
  const account = await newMember(system, "Former admin");
  const organization = system.ownerAuth().organization;
  const [org] = await organization.list();
  if (!org) throw new Error("The hub has no Organization");
  const { members } = await organization.listMembers({ query: { organizationId: org.id } });
  const member = members.find(({ user }) => user.email === account.email);
  if (!member) throw new Error("The Organization has no such member");
  const membership = { memberId: member.id, organizationId: org.id };
  await organization.updateMemberRole({ ...membership, role: "admin" });
  await signInAt(system, page, "usage", account);
  await expectBrowser(page.getByRole("link", { name: "statements" })).toBeVisible();

  await organization.updateMemberRole({ ...membership, role: "member" });
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expectBrowser(
    page.getByText(/Each Batch's page shows what that Batch has used/),
  ).toBeVisible();
  await expectBrowser(page.getByRole("table")).toHaveCount(0);
}, 30_000);

test("west of UTC a job end keeps its UTC weekday, day and year in a cross-year report", async () => {
  const page = await newPage("America/Los_Angeles");
  await signInAt(system, page, "usage?period=400d", OWNER);
  const report = await system.owner().usage.get({ period: "400d" });
  const day = report.days.find(({ jobEnds }) => jobEnds > 0);
  if (!day) throw new Error("The window has no job ends");
  const expected = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  })
    .format(new Date(day.date))
    .replace(",", "");
  const daily = page.getByRole("table", { name: "By day" });
  const cell = page.locator(`time[datetime="${day.date}"]`);
  await expectBrowser(cell).toHaveText(expected);
  for (const body of await daily.locator("tbody").all()) {
    const heading = await body.locator('th[scope="rowgroup"]').innerText();
    const years = await body
      .locator("time")
      .evaluateAll((dates) => dates.map((date) => date.dateTime.slice(0, 4)));
    expect(new Set(years)).toEqual(new Set([heading]));
  }
  await expectBrowser(
    daily.getByRole("row").filter({ has: cell }).getByRole("cell").first(),
  ).toHaveText(String(day.jobEnds));
}, 30_000);

test("a member can correct a refused range and leave the end open through today", async () => {
  const page = await newPage();
  await signInAt(system, page, "usage?period=7d", OWNER);
  const days = page.getByRole("table", { name: "By day" }).locator("tbody time");
  await expectBrowser(days).toHaveCount(7);
  const first = await days.first().getAttribute("datetime");
  const last = await days.last().getAttribute("datetime");
  if (!first || !last) throw new Error("The report has no dated window");
  await page.getByLabel("Range").selectOption("custom");
  const from = page.getByLabel("From", { exact: true });
  const to = page.getByLabel("To", { exact: true });
  await expectBrowser(from).toHaveValue(first);
  await expectBrowser(to).toHaveValue(last);
  await from.fill("2000-01-01");
  await to.fill("");
  const show = page.getByRole("button", { name: "Show", exact: true });
  await show.click();
  await expectBrowser(from).toBeFocused();
  await expectBrowser(from).toHaveJSProperty(
    "validationMessage",
    "Choose at most 400 days, counting both From and To.",
  );
  await expectBrowser(page.getByRole("alert")).toHaveCount(0);
  await from.fill("2099-01-01");
  const pending = Promise.withResolvers<Route>();
  await page.route(
    (url) => url.pathname === "/usage" && url.searchParams.get("from") === "2099-01-01",
    (route) => pending.resolve(route),
    { times: 1 },
  );
  await show.click();
  const request = await pending.promise;
  await from.fill(first);
  await request.continue();
  await expectBrowser(from).toHaveAccessibleDescription("Must not be after today");
  await expectBrowser(from).toHaveValue(first);
  await expectBrowser(from).toBeFocused();
  await expectBrowser(page.getByRole("alert")).toHaveCount(0);
  const range = page.getByLabel("Range");
  await range.selectOption("7d");
  await expectBrowser(range).not.toHaveAttribute("aria-invalid", "true");
  await expectBrowser(page.getByRole("alert")).toHaveText("Must not be after today");
  await range.selectOption("custom");
  await expectBrowser(from).toHaveAccessibleDescription("Must not be after today");
  await from.fill(first);
  const read = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/usage" && url.searchParams.get("from") === first && response.ok();
  });
  await show.click();
  const answer = await (await read).json();
  await expectBrowser(days).toHaveCount(answer.days.length);
  await expectBrowser(days.last()).toHaveAttribute("datetime", answer.today);
  await expectBrowser(page.locator(".report-range")).toContainText("(UTC) so far.");
  expect(new URL(page.url()).searchParams.has("to")).toBe(false);
  await page.goBack();
  await expectBrowser(from).toHaveValue("2099-01-01");
  await page.goForward();
  await expectBrowser(from).toHaveValue(first);
}, 30_000);
