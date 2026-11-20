import type { Browser } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterAll, beforeAll, beforeEach, expect, onTestFinished, test } from "vite-plus/test";

import { formatCount, formatUsd } from "../../dashboard/src/format.ts";
import { launchDashboardBrowser, newMember, signInAt } from "./dashboard-browser.ts";
import { OWNER, startSystem, untilStatus } from "./harness.ts";
import { callTool } from "./scripted-model.ts";

const system = startSystem();
let browser: Browser;

beforeAll(async () => {
  await system.start();
  browser = await launchDashboardBrowser(system);
});

async function seedUsage() {
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
      system.model.setResponses([callTool("submit_output", { value: 1 })]);
      await system.startRunner();
      await untilStatus(owner, added.job.id, "succeeded");
    }
  }
}
// untilStatus uses a polling assertion, which runs in a test context.
let seeded: Promise<void> | undefined;
beforeEach(() => (seeded ??= seedUsage()));
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
  const report = await system.owner().usage.get({ groupBy: "batch" });
  const group = page.getByRole("table", { name: "By Batch" });
  await expectBrowser(group.getByRole("rowheader")).toHaveText(["statements", "receipts", "Total"]);
  const daily = page.getByRole("table", { name: "By day" });
  await expectBrowser(daily.getByRole("rowheader")).toHaveCount(31);
  const figures = [
    "2",
    formatCount(report.usage.totalTokens),
    formatUsd(report.usage.cost.totalUsd),
  ];
  for (const ledger of [group, daily]) {
    await expectBrowser(ledger.locator("tfoot td.num")).toHaveText(figures);
  }
  await expectBrowser(daily.locator("tbody tr").first().locator("td.num")).toHaveText([
    "0",
    "0",
    "0.0000",
  ]);
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
    page.getByRole("table", { name: "By day" }).getByRole("rowheader"),
  ).toHaveCount(8);
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

test("west of UTC a job end keeps its UTC calendar day and weekday", async () => {
  const page = await newPage("America/Los_Angeles");
  await signInAt(system, page, "usage", OWNER);
  const report = await system.owner().usage.get({});
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
  await expectBrowser(
    daily.getByRole("row").filter({ has: cell }).getByRole("cell").first(),
  ).toHaveText(String(day.jobEnds));
}, 30_000);

test("a member can correct a refused range and leave the end open through today", async () => {
  const page = await newPage();
  await signInAt(system, page, "usage?period=7d", OWNER);
  const report = await system.owner().usage.get({ period: "7d" });
  await page.getByLabel("Range").selectOption("custom");
  const from = page.getByLabel("From", { exact: true });
  const to = page.getByLabel("To", { exact: true });
  await expectBrowser(from).toHaveValue(report.from);
  await expectBrowser(to).toHaveValue(report.to);
  await from.fill("2000-01-01");
  await to.fill("");
  const show = page.getByRole("button", { name: "Show", exact: true });
  await show.click();
  const refusal = page.getByRole("alert");
  await expectBrowser(refusal).toContainText("400 days");
  await expectBrowser(from).toHaveValue("2000-01-01");
  await expectBrowser(to).toHaveValue("");
  await expectBrowser(show).toBeFocused();
  const retry = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/usage" && response.status() === 400,
  );
  await show.click();
  await retry;
  await expectBrowser(refusal).toContainText("400 days");
  await expectBrowser(show).toBeFocused();
  await expectBrowser(show).not.toHaveAttribute("aria-disabled", "true");
  await from.fill(report.today);
  await show.click();
  await expectBrowser(page.getByRole("table", { name: "By day" }).locator("tbody tr")).toHaveCount(
    1,
  );
  expect(new URL(page.url()).searchParams.has("to")).toBe(false);
}, 30_000);
