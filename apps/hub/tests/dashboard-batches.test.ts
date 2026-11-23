import type { Browser } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterAll, assert, beforeAll, expect, onTestFinished, test } from "vite-plus/test";

import { launchDashboardBrowser, newMember, signInAt } from "./dashboard-browser.ts";
import { backdateJobContact, startSystem } from "./harness.ts";

const system = startSystem();
const agent = { outputContract: { schema: {} } };
let browser: Browser;
beforeAll(async () => {
  await system.start();
  browser = await launchDashboardBrowser(system);
});
afterAll(async () => {
  await browser?.close();
  await system.stop();
});

async function open(name: string, path: string) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  onTestFinished(() => page.close());
  await signInAt(system, page, path, await newMember(system, name));
  return page;
}

test("a member pages through Batches matching a status and a Label, including after a reload", async () => {
  const client = system.owner();
  const labels = { "example.com/team": "East & West" };
  const create = (id: string) => client.batches.create({ id, agent, labels });
  for (let i = 0; i < 51; i++) await create(`statements-${i}`);
  const paused = await create("paused-statements");
  await client.batches.pause({ id: paused.id });
  await client.batches.create({ id: "other-team", agent, labels: { "example.com/team": "" } });

  const page = await open("Batch reader", "batches");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByRole("checkbox", { name: "Active" }).check();
  await page.getByLabel("Label key").fill("example.com/team");
  await page.getByLabel("Label value").fill("East & West");
  await page.getByRole("button", { name: "Apply" }).click();
  await expectBrowser(page.getByRole("button", { name: "Filters (2 applied)" })).toBeFocused();
  const links = page.getByRole("table", { name: "Batches" }).getByRole("link");
  await expectBrowser(links).toHaveCount(50);
  await expectBrowser(links.first()).toHaveText("statements-50");
  await page.getByRole("link", { name: "Older Batches" }).click();
  await expectBrowser(links).toHaveText(["statements-0"]);
  await page.reload();
  await expectBrowser(links).toHaveText(["statements-0"]);
  await page.getByRole("link", { name: "Newest Batches" }).click();
  await expectBrowser(links.first()).toHaveText("statements-50");

  await page.getByRole("button", { name: "Filters (2 applied)" }).click();
  await page.getByLabel("Label value").fill("");
  await page.getByRole("button", { name: "Apply" }).click();
  await expectBrowser(links).toHaveText(["other-team"]);
  await page.reload();
  await expectBrowser(links).toHaveText(["other-team"]);
}, 60_000);

test("clearing a drafted Label lets a member filter by status alone", async () => {
  const { id } = await system.owner().batches.create({ id: "draft-label", agent });
  const page = await open("Label editor", "batches?status=paused");
  await page.getByRole("button", { name: "Filters (1 applied)" }).click();
  await page.getByLabel("Label value").fill("unapplied");
  await expectBrowser(page.getByLabel("Label key")).toHaveJSProperty("required", true);
  await page.getByRole("link", { name: "Clear", exact: true }).click();
  const filters = page.getByRole("button", { name: "Filters", exact: true });
  await expectBrowser(filters).toBeFocused();
  await filters.click();
  await expectBrowser(page.getByLabel("Label value")).toHaveValue("");
  await page.getByRole("checkbox", { name: "Active" }).check();
  await page.getByRole("button", { name: "Apply" }).click();
  await expectBrowser(page.getByRole("button", { name: "Filters (1 applied)" })).toBeFocused();
  await expectBrowser(page.getByRole("link", { name: id, exact: true })).toBeVisible();
}, 30_000);

test("a member sees a Batch control in flight and its result on the record and list", async () => {
  const { id } = await system.owner().batches.create({ id: "november-control", agent });
  const page = await open("Batch operator", "batches");
  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: id }) });
  await row.getByRole("link").click();
  const pause = page.getByRole("button", { name: "Pause", exact: true });
  const release = Promise.withResolvers<void>();
  await page.route(`**/batches/${id}/pause`, async (route) => {
    await release.promise;
    await route.continue();
  });
  try {
    await pause.click();
    await expectBrowser(pause).toBeDisabled();
    await expectBrowser(
      page.getByRole("button", { name: `Cancel the Batch ${id}` }),
    ).toBeDisabled();
    const working = page.locator("#batch-status").getByText("Working…");
    await expectBrowser(working).toBeVisible();
    // Kept out of the status region's text: the pressed button tells a screen reader it waits.
    await expectBrowser(working).toHaveAttribute("aria-hidden", "true");
    // A pause from elsewhere lands first: the next read withdraws Pause and its note.
    await system.owner().batches.pause({ id });
    await expectBrowser(page.getByRole("button", { name: "Resume" })).toBeVisible({
      timeout: 15_000,
    });
    await expectBrowser(page.locator("#pause-note")).toHaveCount(0);
    await expectBrowser(pause).toBeFocused();
    await expectBrowser(pause).toHaveAttribute("aria-busy", "true");
    await expectBrowser(pause).toHaveAccessibleDescription(/By a caller/);
  } finally {
    release.resolve();
  }
  await expectBrowser(page.getByRole("status").filter({ hasText: "By a caller" })).toBeFocused();
  await expectBrowser(pause).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "Where this is" })
    .getByRole("link", { name: "Batches" })
    .click();
  await expectBrowser(row).toContainText("by a caller");
  await row.getByRole("link").click();
  await page.getByRole("button", { name: "Resume" }).click();
  await expectBrowser(page.getByRole("status").filter({ hasText: "Active" })).toBeFocused();
}, 30_000);

test("cancelling a Batch asks first and removes its controls once final", async () => {
  const { id } = await system.owner().batches.create({ id: "withdrawn", agent });
  const page = await open("Batch cancellation", `batches/${id}`);
  await page.getByRole("button", { name: `Cancel the Batch ${id}` }).click();
  const dialog = page.getByRole("alertdialog");
  await expectBrowser(dialog.getByRole("button", { name: "Keep it" })).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel the Batch", exact: true }).click();
  await expectBrowser(page.getByRole("status").filter({ hasText: "Cancelled" })).toBeFocused();
  await expectBrowser(
    page
      .getByRole("main")
      .getByRole("button", { name: /^(Pause|Resume|Cancel(?: the Batch .+)?)$/ }),
  ).toHaveCount(0);
}, 30_000);

test("a second press while the hub answers a cancel sends it once", async () => {
  const { id } = await system.owner().batches.create({ id: "pressed-twice", agent });
  const page = await open("Twice presser", `batches/${id}`);
  let sent = 0;
  const release = Promise.withResolvers<void>();
  await page.route(`**/batches/${id}/cancel`, async (route) => {
    sent += 1;
    await release.promise;
    await route.continue();
  });
  await page.getByRole("button", { name: `Cancel the Batch ${id}` }).click();
  const dialog = page.getByRole("alertdialog");
  const confirm = dialog.getByRole("button", { name: "Cancel the Batch", exact: true });
  try {
    await confirm.click();
    await expectBrowser(dialog.getByText("Working…")).toBeVisible();
    await expectBrowser(page.locator("#batch-status")).toContainText("Working…");
    // As a member's second click lands, whether or not the button takes it.
    await confirm.click({ force: true });
  } finally {
    release.resolve();
  }
  await expectBrowser(page.getByRole("status").filter({ hasText: "Cancelled" })).toBeFocused();
  expect(sent).toBe(1);
}, 30_000);

test("a cancel confirmed offline fails at once and is not sent once back online", async () => {
  const client = system.owner();
  const { id } = await client.batches.create({ id: "offline-cancel", agent });
  const page = await open("Offline operator", `batches/${id}`);
  await page.getByRole("button", { name: `Cancel the Batch ${id}` }).click();
  const dialog = page.getByRole("alertdialog");
  await page.context().setOffline(true);
  await dialog.getByRole("button", { name: "Cancel the Batch", exact: true }).click();
  await expectBrowser(dialog.getByRole("alert")).toHaveText(
    "The dashboard could not confirm this was done. Check before trying again.",
  );
  // Back online, Query sends what it held before it reads the shown Batch again.
  const reread = page.waitForResponse((response) => response.url().endsWith(`/batches/${id}`));
  await page.context().setOffline(false);
  await reread;
  expect((await client.batches.get({ id })).status).toBe("active");
}, 30_000);

test("an open Cancel keeps the counts of its press, and shows when another caller cancels first", async () => {
  const client = system.owner();
  const { id, jobs } = await client.batches.create({
    id: "counted-at-press",
    agent,
    jobs: [
      { customId: "first", input: "Count the invoices." },
      { customId: "second", input: "Count the receipts." },
    ],
  });
  const [first, second] = jobs;
  assert(first && second);
  const runner = await system.connectReportingRunner();
  onTestFinished(() => runner.close());
  // Sent and gone unheard, the first job keeps the Batch's cancel waiting for its Runner.
  await runner.place(first.job.id);
  await backdateJobContact([first.job.id]);
  const page = await open("Counts at the press", `batches/${id}`);
  const sent = { count: 0 };
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/batches/${id}/cancel`) sent.count += 1;
  });
  const cancel = page.getByRole("button", { name: `Cancel the Batch ${id}` });
  await cancel.click();
  const dialog = page.getByRole("alertdialog");
  const atPress = ["It has 2 unfinished jobs.", "1 of its jobs has status unknown"];
  for (const words of atPress) await expectBrowser(dialog).toContainText(words);
  const confirm = dialog.getByRole("button", { name: "Cancel the Batch", exact: true });
  await page.keyboard.press("Tab");
  await expectBrowser(confirm).toBeFocused();

  await backdateJobContact([second.job.id]);
  await client.batches.addJobs({ id, jobs: [{ customId: "third", input: "Count the refunds." }] });
  await expectBrowser(page.locator("#cancel-note")).toContainText("3 unfinished jobs", {
    timeout: 15_000,
  });
  await expectBrowser(page.locator("main")).toContainText("2 of these have status unknown");
  for (const words of atPress) await expectBrowser(dialog).toContainText(words);

  await client.batches.cancel({ id });
  await expectBrowser(dialog).toContainText("Cancel has already been asked.", { timeout: 15_000 });
  await expectBrowser(confirm).toBeFocused();
  await page.keyboard.press("Enter");
  await confirm.click({ force: true });
  await page.keyboard.press("Escape");
  await expectBrowser(dialog).toHaveCount(0);
  await expectBrowser(cancel).toBeFocused();
  expect(sent.count).toBe(0);
}, 45_000);

test("confirming a Batch's Cancel clears an earlier failure as it starts", async () => {
  const { id } = await system.owner().batches.create({ id: "failure-cleared", agent });
  const page = await open("Batch failure cleared", `batches/${id}`);
  await page.route(
    `**/batches/${id}/pause`,
    (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/problem+json",
        json: { type: "about:blank", title: "Conflict", status: 409, detail: "Try again." },
      }),
    { times: 1 },
  );
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const failure = page.locator('main [role="alert"]');
  await expectBrowser(failure).toHaveText("Pause the Batch: Try again.");
  await page.getByRole("button", { name: `Cancel the Batch ${id}` }).click();
  const dialog = page.getByRole("alertdialog");
  const release = Promise.withResolvers<void>();
  await page.route(`**/batches/${id}/cancel`, async (route) => {
    await release.promise;
    await route.continue();
  });
  try {
    await dialog.getByRole("button", { name: "Cancel the Batch", exact: true }).click();
    await expectBrowser(dialog.getByText("Working…")).toBeVisible();
    await expectBrowser(failure).toHaveCount(0);
  } finally {
    release.resolve();
  }
  await expectBrowser(page.getByRole("status").filter({ hasText: "Cancelled" })).toBeFocused();
}, 30_000);

test("a Batch ledger opens the jobs it counts and a job links back to the Batch", async () => {
  const client = system.owner();
  const { id } = await client.batches.create({ id: "MixedCase-2026", agent, breaker: false });
  const { jobs } = await client.batches.addJobs({
    id,
    jobs: [
      { customId: "keep", input: "Read." },
      { customId: "stop", input: "Read." },
    ],
  });
  const other = await client.batches.create({ id: "other-ledger", agent });
  await client.batches.addJobs({ id: other.id, jobs: [{ customId: "elsewhere", input: "Read." }] });
  const stopped = jobs.find(({ job }) => job.customId === "stop");
  if (!stopped) throw new Error("The Batch has no stop job");
  await client.jobs.cancel({ id: stopped.job.id });
  const page = await open("Ledger reader", `batches/${id}`);
  await page.getByRole("link", { name: /See them.*its queued jobs/ }).click();
  const table = page.getByRole("table", { name: "Jobs" });
  await expectBrowser(table.locator(".job-name")).toHaveText(["keep"]);
  await expectBrowser(table.getByRole("link", { name: id })).toHaveAttribute(
    "href",
    `/dashboard/batches/${id}`,
  );
  await table.getByRole("link", { name: "keep" }).click();
  await page
    .getByRole("navigation", { name: "Where this is" })
    .getByRole("link", { name: id })
    .click();
  await expectBrowser(page.getByRole("heading", { level: 1 })).toContainText(id);
}, 30_000);

test("a member sees when the Canary is holding queued jobs", async () => {
  const client = system.owner();
  const { id } = await client.batches.create({
    id: "release-check",
    agent,
    breaker: { canary: 1, maxFailurePercent: 100 },
  });
  await client.batches.addJobs({
    id,
    jobs: [
      { customId: "first", input: "Read." },
      { customId: "next", input: "Read." },
    ],
  });
  const page = await open("Canary reader", `batches/${id}`);
  const status = page.getByRole("status").filter({ hasText: "Active" });
  await expectBrowser(status).toContainText("1 job waiting for its Canary");
}, 30_000);

test("a paused Batch shows as paused, with its controls free and focus on its status, before the jobs it changes are read again", async () => {
  const { id } = await system.owner().batches.create({ id: "slow-counts", agent });
  const page = await open("List waiter", `batches/${id}`);
  const reread = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route(
    (url) => /\/jobs(\/counts)?$/.test(url.pathname),
    async (route) => {
      reread.resolve();
      await release.promise;
      await route.continue();
    },
  );
  try {
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await reread.promise;
    await expectBrowser(page.getByRole("status").filter({ hasText: "By a caller" })).toBeFocused();
    await expectBrowser(page.locator("#batch-status").getByText("Working…")).toHaveCount(0);
    await expectBrowser(page.getByRole("button", { name: "Resume", exact: true })).toBeEnabled();
    await expectBrowser(page.getByRole("button", { name: `Cancel the Batch ${id}` })).toBeEnabled();
  } finally {
    release.resolve();
  }
}, 30_000);
