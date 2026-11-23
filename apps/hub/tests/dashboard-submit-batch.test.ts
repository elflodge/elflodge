import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Browser, Page, Request } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterAll, beforeAll, expect, onTestFinished, test } from "vite-plus/test";

import { launchDashboardBrowser, newMember, signInAt } from "./dashboard-browser.ts";
import { blobRef, startSystem } from "./harness.ts";

const system = startSystem({ hubVars: { JOB_MODEL_BUDGET_USD_MAX: "5" } });
let browser: Browser;

beforeAll(async () => {
  await system.start();
  browser = await launchDashboardBrowser(system);
});
afterAll(async () => {
  await browser?.close();
  await system.stop();
});

/** The Output schema the form starts with. */
const STARTING_SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
};

async function openSubmitBatch(name: string) {
  const page = await browser.newPage();
  onTestFinished(() => page.close());
  await signInAt(system, page, "batches", await newMember(system, name));
  await page.getByRole("link", { name: "Submit a Batch", exact: true }).click();
  await page.getByRole("heading", { name: "Submit a Batch" }).waitFor();
  return page;
}

/** Chooses files of these names and texts with Add files. */
async function addFiles(page: Page, files: readonly (readonly [string, string])[]) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add files" }).click();
  await (
    await chooser
  ).setFiles(
    files.map(([name, text]) => ({ name, mimeType: "text/plain", buffer: Buffer.from(text) })),
  );
}

/** The page's alert. UI SDK keeps its shared live regions, one an alert, beside the page's main. */
const pageAlert = (page: Page) => page.getByRole("main").getByRole("alert");

const isUpload = (request: Request) =>
  request.method() === "PUT" && new URL(request.url()).pathname.includes("/blobs/");
const isCreate = (request: Request) =>
  request.method() === "POST" && new URL(request.url()).pathname.endsWith("/batches");
/** The file of `files` an upload sends, by the digest in its address. */
function uploadedFile(request: Request, files: readonly (readonly [string, string])[]) {
  const address = decodeURIComponent(request.url());
  return files.find(([, text]) => address.includes(blobRef(text).digest))?.[0];
}

test("a Batch of typed jobs and jobs from files is created whole, and the member lands on it", async () => {
  const page = await openSubmitBatch("Batch submitter");
  const files = [
    ["invoice-117.pdf", "Invoice 117: 3 oak shelves, 405.00 EUR."],
    ["invoice-118.pdf", "Invoice 118: 12 hinges, 54.00 EUR."],
  ] as const;
  await page.getByLabel("Instructions").fill("Say whether the invoice's lines add up.");
  await page.getByLabel("Batch ID").fill("invoices-2026-11");
  await page.getByRole("button", { name: "Add a Label" }).click();
  await page.getByLabel("Key of Label 1").fill("customer");
  await page.getByLabel("Value of Label 1").fill("Harbor & Pine");
  await addFiles(page, files);
  await page.getByRole("button", { name: "Add a job" }).click();
  const typed = page.getByLabel("Input of job 3");
  await expectBrowser(typed).toBeFocused();
  await typed.fill("Invoice 119, by phone: 64.80 EUR.");
  await expectBrowser(page.getByRole("group", { name: "Jobs" })).toBeVisible();
  await expectBrowser(page.getByLabel("What Submit sends")).toContainText(
    "3 of at most 1,000: 2 from files, 1 typed",
  );
  await page.getByRole("button", { name: "Submit Batch" }).click();

  await expectBrowser(page.getByRole("heading", { level: 1 })).toContainText("invoices-2026-11");
  await expectBrowser(page.getByRole("row", { name: /All its jobs/ })).toContainText("3");
  await expectBrowser(page.getByRole("complementary")).toContainText("customer=Harbor & Pine");
  const listed = await system.owner().jobs.list({ batchId: "invoices-2026-11" });
  expect(new Set(listed.jobs.map(({ customId }) => customId))).toEqual(
    new Set(["invoice-117.pdf", "invoice-118.pdf", "job-1"]),
  );
  const held = await system.owner().blobs.check({ files: files.map(([, text]) => blobRef(text)) });
  expect(held.files.map(({ stored }) => stored)).toEqual([true, true]);
}, 30_000);

test("the hub's refusals stand at the field or row concerned, with every value kept", async () => {
  await system.owner().batches.create({
    id: "receipts-2026-11",
    agent: { outputContract: { schema: STARTING_SCHEMA } },
    jobs: [{ customId: "job-1", input: "Receipt 1: 12.00 EUR." }],
  });
  const page = await openSubmitBatch("Batch corrector");
  await page.getByRole("button", { name: "Add a job" }).click();
  await page.getByLabel("Input of job 1").fill("Receipt 1: 21.00 EUR.");
  await addFiles(page, [["receipt-2.txt", "Receipt 2: 8.50 EUR."]]);
  await page.getByLabel("Batch ID").fill("receipts-2026-11-new");
  const budget = page.getByLabel("Model budget");
  await budget.fill("6");
  const submit = page.getByRole("button", { name: "Submit Batch" });
  await submit.click();
  await expectBrowser(budget).toBeFocused();
  await expectBrowser(budget).toHaveAccessibleDescription(/Must be at most 5, the hub's maximum/);
  await expectBrowser(page.getByLabel("Input of job 1")).toHaveValue("Receipt 1: 21.00 EUR.");
  await expectBrowser(page.getByRole("cell", { name: /^receipt-2\.txt \d/ })).toBeVisible();

  await budget.fill("");
  await page.getByLabel("Batch ID").fill("receipts-2026-11");
  await submit.click();
  const customId = page.getByLabel("Custom ID of job 1");
  await expectBrowser(customId).toBeFocused();
  await expectBrowser(customId).toHaveAccessibleDescription(
    /Already used in the Batch for a job with other content/,
  );
  await expectBrowser(pageAlert(page)).toHaveText("1 job was refused. It says why at its row: 1");
  await expectBrowser(page.getByLabel("Input of job 1")).toHaveValue("Receipt 1: 21.00 EUR.");
  await expectBrowser(page.getByLabel("Batch ID")).toHaveValue("receipts-2026-11");
}, 30_000);

test("what a row cannot send is told when it is added and stops Submit before anything is sent, and a repeat fixed is no longer told", async () => {
  const page = await openSubmitBatch("Batch gatherer");
  const sent: string[] = [];
  page.on("request", (request) => {
    if (isUpload(request) || isCreate(request)) sent.push(request.url());
  });
  await addFiles(page, [
    ["Report: Q3.pdf", "Q3"],
    ["scan.pdf", "first scan"],
    ["scan.pdf", "second scan"],
  ]);
  await expectBrowser(
    page.getByRole("cell", { name: /^Report: Q3\.pdf \d/ }),
  ).toHaveAccessibleDescription(
    /Must be a relative path of file names valid on Linux, macOS and Windows/,
  );
  for (const job of [2, 3])
    await expectBrowser(page.getByLabel(`Custom ID of job ${job}`)).toHaveAccessibleDescription(
      'Must be unique in the request: "scan.pdf" is given more than once',
    );
  await expectBrowser(page.getByRole("status").filter({ hasText: "added" })).toHaveText(
    "3 files added as jobs 1 to 3. 3 cannot be sent: each says why at its row.",
  );

  await page.getByRole("button", { name: "Submit Batch" }).click();
  const alert = pageAlert(page);
  await expectBrowser(alert).toHaveText("3 jobs cannot be sent. Each says why at its row: 1, 2, 3");

  // Fixing one use of the Custom ID ends the repeat at both rows.
  await page.getByLabel("Custom ID of job 3").fill("scan-2.pdf");
  await page.getByLabel("Custom ID of job 3").blur();
  for (const job of [2, 3])
    await expectBrowser(page.getByLabel(`Custom ID of job ${job}`)).not.toHaveAttribute(
      "aria-invalid",
      "true",
    );
  await expectBrowser(alert).toHaveText("1 job cannot be sent. It says why at its row: 1");
  // The link leads to the cell that carries the words.
  await alert.getByRole("link", { name: "1" }).click();
  await expectBrowser(page.getByRole("cell", { name: /^Report: Q3\.pdf \d/ })).toBeFocused();
  // The alert tells what stands now.
  await page.getByRole("button", { name: "Remove job 1" }).click();
  await expectBrowser(alert).toBeHidden();
  expect(sent).toEqual([]);
}, 30_000);

test("Submit again after a stop and after a failed upload uploads only what is missing and creates one Batch", async () => {
  const page = await openSubmitBatch("Batch sender");
  const files = [
    ["a.txt", "alpha"],
    ["b.txt", "bravo"],
    ["c.txt", "charlie"],
  ] as const;
  const creates: string[] = [];
  page.on("request", (request) => {
    if (isCreate(request)) creates.push(request.url());
  });
  await page.getByLabel("Batch ID").fill("letters");
  await addFiles(page, files);
  const submit = page.getByRole("button", { name: "Submit Batch" });

  // First: a.txt is uploaded, the others are held until Stop.
  const held = Promise.withResolvers<void>();
  await page.route("**/blobs/**", async (route) => {
    if (!isUpload(route.request()) || uploadedFile(route.request(), files) === "a.txt")
      return route.continue();
    await held.promise;
    await route.abort().catch(() => undefined);
  });
  await submit.click();
  await page.getByText("Uploaded 1 of 3 files", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Stop" }).click();
  await expectBrowser(page.getByRole("status").filter({ hasText: "Stopped." })).toHaveText(
    "Stopped. No Batch was created. Submit again reads the files again and uploads only what the hub does not hold.",
  );
  held.resolve();
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // Then: b.txt fails, c.txt is uploaded, and a.txt, which the hub holds, is not sent.
  let tried: (string | undefined)[] = [];
  await page.route("**/blobs/**", async (route) => {
    if (!isUpload(route.request())) return route.continue();
    const name = uploadedFile(route.request(), files);
    tried.push(name);
    if (name !== "b.txt") return route.continue();
    await route.fulfill({
      status: 503,
      contentType: "application/problem+json",
      body: JSON.stringify({
        type: "about:blank",
        title: "Service Unavailable",
        status: 503,
        detail: "The hub is busy.",
      }),
    });
  });
  await submit.click();
  await expectBrowser(pageAlert(page)).toHaveText(
    "1 file was not uploaded. No Batch was created. It says why at its row: 2\nSubmit again reads the files again and uploads only what the hub does not hold.",
  );
  await expectBrowser(page.getByRole("cell", { name: /^b\.txt \d/ })).toHaveAccessibleDescription(
    /The hub is busy\./,
  );
  expect(new Set(tried)).toEqual(new Set(["b.txt", "c.txt"]));
  expect(tried).toHaveLength(2);
  await page.unrouteAll({ behavior: "wait" });

  tried = [];
  page.on("request", (request) => {
    if (isUpload(request)) tried.push(uploadedFile(request, files));
  });
  await submit.click();
  await expectBrowser(page.getByRole("heading", { level: 1 })).toContainText("letters");
  expect(tried).toEqual(["b.txt"]);
  expect(creates).toHaveLength(1);
  await expectBrowser(page.getByRole("row", { name: /All its jobs/ })).toContainText("3");
}, 30_000);

test("Stop pressed as the last upload is told sends no create", async () => {
  const page = await openSubmitBatch("Batch stopper");
  await page.getByLabel("Batch ID").fill("stopped-late");
  // Contents of this run's own, as a retry against the same Organization would find them held.
  await addFiles(page, [["late.txt", `Stopped as its upload is told, ${crypto.randomUUID()}.`]]);
  const creates: string[] = [];
  page.on("request", (request) => {
    if (isCreate(request)) creates.push(request.url());
  });
  // Pressed in the same turn the page shows the last upload, before anything else of the send runs.
  // A string, as these tests are typed without the DOM's names.
  await page.evaluate(`(() => {
    new MutationObserver((_, observer) => {
      if (!document.body.textContent.includes("Uploaded 1 of 1")) return;
      observer.disconnect();
      [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Stop")?.click();
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  })()`);
  await page.getByRole("button", { name: "Submit Batch" }).click();
  await expectBrowser(page.getByRole("status").filter({ hasText: "Stopped." })).toHaveText(
    "Stopped. No Batch was created. Submit again reads the files again and uploads only what the hub does not hold.",
  );
  expect(creates).toEqual([]);
}, 30_000);

test("Leave confirmed while an upload is held sends no create", async () => {
  const page = await openSubmitBatch("Batch leaver");
  await page.getByLabel("Batch ID").fill("left-late");
  await addFiles(page, [["left.txt", `Left while uploading, ${crypto.randomUUID()}.`]]);
  const creates: string[] = [];
  page.on("request", (request) => {
    if (isCreate(request)) creates.push(request.url());
  });
  const reached = Promise.withResolvers<void>();
  const upload = Promise.withResolvers<void>();
  await page.route("**/blobs/**", async (route) => {
    if (!isUpload(route.request())) return route.continue();
    reached.resolve();
    await upload.promise;
    // The page has dropped the request by now.
    await route.continue().catch(() => undefined);
  });
  await page.getByRole("button", { name: "Submit Batch" }).click();
  await reached.promise;
  // The session read of the next page is held, so this page stays while the next one loads.
  const session = Promise.withResolvers<void>();
  await page.route("**/api/auth/get-session", async (route) => {
    await session.promise;
    await route.continue();
  });
  await page
    .getByRole("navigation", { name: "Where this is" })
    .getByRole("link", { name: "Batches" })
    .click();
  const dialog = page.getByRole("alertdialog", { name: "Leave without submitting?" });
  await dialog.getByRole("button", { name: "Leave the page" }).click();
  // Stopped by Leave itself, while the page is still here.
  await expectBrowser(page.getByRole("status").filter({ hasText: "Stopped." })).toBeVisible();
  upload.resolve();
  session.resolve();
  await expectBrowser(page.getByRole("heading", { level: 1 })).toHaveText("Batches");
  expect(creates).toEqual([]);
}, 30_000);

test("after a lost answer the Batch ID field holds the ID sent: an edit cannot make a second Batch, and another ID says one may exist", async () => {
  const page = await openSubmitBatch("Batch retrier");
  await page.getByRole("button", { name: "Add a job" }).click();
  await page.getByLabel("Input of job 1").fill("Receipt 3: 4.20 EUR.");
  let firstStatus: number | undefined;
  await page.route("**/batches", async (route) => {
    if (!isCreate(route.request())) return route.continue();
    // The hub makes the Batch; its answer never reaches the page. The browser alone resolves the
    // hub's name, so the request goes to the hub's address.
    const answer = await route.fetch({
      url: route.request().url().replace(system.origin, system.url().origin),
    });
    firstStatus = answer.status();
    await route.abort("connectionreset");
  });
  const submit = page.getByRole("button", { name: "Submit Batch" });
  const batchId = page.getByLabel("Batch ID");
  const alert = pageAlert(page);
  const create = page.waitForRequest(isCreate);
  await submit.click();
  const sentId: string = (await create).postDataJSON().id;
  await expectBrowser(alert).toContainText(
    `The hub may already have a Batch under this Batch ID: ${sentId} (opens in a new tab). Submit again to find out: the same values return that Batch.`,
  );
  // The first create made the Batch, under the ID the page made, which the field now holds.
  expect(firstStatus).toBe(200);
  await expectBrowser(batchId).toHaveValue(sentId);
  // The link opens the Batch beside the draft, which stays as it is.
  const [tab] = await Promise.all([
    page.context().waitForEvent("page"),
    alert.getByRole("link", { name: sentId }).click(),
  ]);
  await expectBrowser(tab.getByRole("heading", { level: 1 })).toContainText(sentId);
  await tab.close();
  await expectBrowser(page.getByRole("heading", { level: 1 })).toHaveText("Submit a Batch");
  // Removing rows here would remove nothing from that Batch, and the dialog does not say otherwise.
  await page.getByRole("button", { name: "Remove all" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Remove the job?" });
  await expectBrowser(dialog).toContainText("A Batch the hub may already have keeps its jobs.");
  await expectBrowser(dialog).not.toContainText("not been submitted");
  await dialog.getByRole("button", { name: "Keep it" }).click();
  await page.unrouteAll({ behavior: "wait" });

  // An edit keeps the ID, so the hub refuses the changed Batch instead of making a second one.
  const instructions = page.getByLabel("Instructions");
  await instructions.fill("Add up the receipt.");
  await submit.click();
  await expectBrowser(batchId).toHaveAttribute("aria-invalid", "true");
  // Another ID would make another Batch, which the alert says.
  await batchId.fill("receipts-again");
  await expectBrowser(alert).toHaveText(
    `The hub may already have a Batch from an earlier submission: ${sentId} (opens in a new tab). Submitting now goes under another Batch ID and leaves that one as it is.`,
  );
  await batchId.fill(sentId);
  await instructions.fill("");
  await submit.click();
  await expectBrowser(page.getByRole("heading", { level: 1 })).toContainText(sentId);
  await expectBrowser(page.getByRole("row", { name: /All its jobs/ })).toContainText("1");
}, 30_000);

test("a Batch of typed jobs says it is being created, and leaving meanwhile says the hub may have it until it lands there", async () => {
  const page = await openSubmitBatch("Batch waiter");
  await page.getByLabel("Batch ID").fill("typed-only");
  await page.getByRole("button", { name: "Add a job" }).click();
  await page.getByLabel("Input of job 1").fill("Receipt 4: 9.10 EUR.");
  const held = Promise.withResolvers<void>();
  await page.route("**/batches", async (route) => {
    if (!isCreate(route.request())) return route.continue();
    await held.promise;
    await route.continue();
  });
  await page.getByRole("button", { name: "Submit Batch" }).click();
  await expectBrowser(page.getByRole("status").filter({ hasText: "Creating" })).toHaveText(
    "Creating the Batch…",
  );
  await page
    .getByRole("navigation", { name: "Where this is" })
    .getByRole("link", { name: "Batches" })
    .click();
  const dialog = page.getByRole("alertdialog", { name: "Leave this page?" });
  await expectBrowser(dialog).toContainText(
    "The hub may already have a Batch from this page: look for it in Batches before submitting it again.",
  );
  // The Batch is made while the question is open, which gives way to it at once, while the session
  // read of the Batch's page is held, so this page stays while that one loads.
  const reached = Promise.withResolvers<void>();
  const record = Promise.withResolvers<void>();
  await page.route("**/api/auth/get-session", async (route) => {
    reached.resolve();
    await record.promise;
    await route.continue();
  });
  const entries = await page.evaluate("history.length");
  held.resolve();
  try {
    await reached.promise;
    await expectBrowser(page.getByRole("alertdialog")).toHaveCount(0);
    await expectBrowser(page.locator('[data-slot="alert-dialog-content"]')).toHaveCount(0);
    await expectBrowser(page.getByRole("heading", { level: 1 })).toHaveText("Submit a Batch");
  } finally {
    record.resolve();
  }
  await expectBrowser(page.getByRole("heading", { level: 1 })).toContainText("typed-only");
  expect(await page.evaluate("history.length")).toBe(Number(entries) + 1);
  await expectBrowser(page.locator("[inert]")).toHaveCount(0);
  await expectBrowser(page.locator('[data-slot="alert-dialog-content"]')).toHaveCount(0);
}, 30_000);

test("Leave asked while files upload says so once the create is sent, and chosen then, keeps to where the member was going", async () => {
  const page = await openSubmitBatch("Batch waverer");
  await page.getByLabel("Batch ID").fill("sent-while-asked");
  await addFiles(page, [["asked.txt", `Sent while asked, ${crypto.randomUUID()}.`]]);
  const reached = Promise.withResolvers<void>();
  const upload = Promise.withResolvers<void>();
  await page.route("**/blobs/**", async (route) => {
    if (!isUpload(route.request())) return route.continue();
    reached.resolve();
    await upload.promise;
    await route.continue();
  });
  const sent = Promise.withResolvers<void>();
  const create = Promise.withResolvers<void>();
  await page.route("**/batches", async (route) => {
    if (!isCreate(route.request())) return route.continue();
    sent.resolve();
    await create.promise;
    await route.continue();
  });
  await page.getByRole("button", { name: "Submit Batch" }).click();
  await reached.promise;
  await page
    .getByRole("navigation", { name: "Where this is" })
    .getByRole("link", { name: "Batches" })
    .click();
  const description = page
    .getByRole("alertdialog")
    .locator('[data-slot="alert-dialog-description"]');
  await expectBrowser(description).toContainText("The Batch has not been submitted.");
  // A polite live region before the words change, so a screen reader hears the change.
  await expectBrowser(description).toHaveAttribute("aria-live", "polite");
  const element = await description.elementHandle();
  // The session read of Batches is held, so this page stays while the create answers.
  const leaving = Promise.withResolvers<void>();
  const session = Promise.withResolvers<void>();
  await page.route("**/api/auth/get-session", async (route) => {
    leaving.resolve();
    await session.promise;
    await route.continue();
  });
  try {
    upload.resolve();
    await sent.promise;
    await expect
      .poll(() => element?.textContent())
      .toContain("The hub may already have a Batch from this page");
    const entries = await page.evaluate("history.length");
    await page.getByRole("alertdialog").getByRole("button", { name: "Leave the page" }).click();
    await leaving.promise;
    const answered = page.waitForResponse((response) => isCreate(response.request()));
    create.resolve();
    expect((await answered).ok()).toBe(true);
    // The draft has taken the success, while Batches still loads: chosen to leave, it does not follow
    // the Batch, and says the hub may have it.
    await expectBrowser(pageAlert(page)).toContainText(
      "The hub may already have a Batch under this Batch ID: sent-while-asked",
    );
    session.resolve();
    await expectBrowser(page.getByRole("heading", { level: 1 })).toHaveText("Batches");
    await expectBrowser(page).toHaveURL(/\/batches$/);
    expect(await page.evaluate("history.length")).toBe(Number(entries) + 1);
  } finally {
    create.resolve();
    session.resolve();
  }
}, 30_000);

test("Remove all asks first: keeping keeps every job, and removing sends nothing, says so and leaves focus on Add files", async () => {
  const page = await openSubmitBatch("Batch tidier");
  // A submission of the page's form starts in the click that causes it, so counting them needs no
  // wait. A string, as these tests are typed without the DOM's names.
  await page.evaluate(`(() => {
    window.submissions = 0;
    document.querySelector("form.fields").addEventListener("submit", () => window.submissions++);
  })()`);
  await addFiles(page, [["note.txt", "A note."]]);
  await page.getByRole("button", { name: "Add a job" }).click();
  await page.getByLabel("Input of job 2").fill("Typed.");
  const removeAll = page.getByRole("button", { name: "Remove all" });
  const dialog = page.getByRole("alertdialog", { name: "Remove all 2 jobs?" });
  await removeAll.click();
  await dialog.getByRole("button", { name: "Keep them" }).click();
  await expectBrowser(dialog).toBeHidden();
  await removeAll.click();
  await expectBrowser(dialog.getByRole("button", { name: "Keep them" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expectBrowser(dialog).toBeHidden();
  await expectBrowser(page.getByLabel("Custom ID of job 2")).toBeVisible();
  // Pressed without taking focus, as a click does not in Safari.
  await page.getByLabel("Input of job 2").focus();
  await removeAll.dispatchEvent("click");
  await expectBrowser(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expectBrowser(dialog).toBeHidden();
  await expectBrowser(removeAll).toBeFocused();
  await expectBrowser(page.getByLabel("Custom ID of job 2")).toBeVisible();
  // The rows go while the limits, from which the draft's figures are recomputed, are read again:
  // back on the tab, Query reads them again once they are stale.
  await expectBrowser(page.getByLabel("Model budget")).toHaveAccessibleDescription(/At most/);
  let reread = false;
  const release = Promise.withResolvers<void>();
  await page.route("**/jobs/limits", async (route) => {
    reread = true;
    await release.promise;
    await route.continue();
  });
  try {
    await expect
      .poll(
        async () => {
          await page.evaluate(`window.dispatchEvent(new Event("visibilitychange"))`);
          return reread;
        },
        { timeout: 5_000 },
      )
      .toBe(true);
    await removeAll.click();
    await dialog.getByRole("button", { name: "Remove 2 jobs" }).click();
    await expectBrowser(page.getByLabel("Custom ID of job 1")).toBeHidden();
    await expectBrowser(
      page.getByRole("status").filter({ hasText: "All 2 jobs removed." }),
    ).toBeVisible();
    await expectBrowser(page.locator('[data-slot="alert-dialog-content"]')).toHaveCount(0);
    await expectBrowser(page.getByRole("button", { name: "Add files" })).toBeFocused();
  } finally {
    release.resolve();
  }
  expect(await page.evaluate("window.submissions")).toBe(0);
}, 30_000);

test("a file dropped on the Jobs group adds a job, but not while Remove all asks", async () => {
  const page = await openSubmitBatch("Batch dropper");
  await page.getByRole("button", { name: "Add a job" }).click();
  const folder = await mkdtemp(path.join(tmpdir(), "dropped-"));
  onTestFinished(() => rm(folder, { recursive: true }));
  const dropped = path.join(folder, "dropped.txt");
  await writeFile(dropped, "Dropped.");
  const group = page.getByRole("group", { name: "Jobs" });
  const input = await page.context().newCDPSession(page);
  // Dropped as a person drops it, through the browser's own hit test, at the group's start, beside
  // where a dialog shows.
  async function drop() {
    const box = await group.boundingBox();
    if (!box) throw new Error("The Jobs group is not shown.");
    const at = { x: box.x + 10, y: box.y + box.height / 2 };
    const data = { items: [], files: [dropped], dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"] as const)
      await input.send("Input.dispatchDragEvent", { type, ...at, data });
  }
  await drop();
  await expectBrowser(page.getByLabel("Custom ID of job 2")).toBeVisible();
  await page.getByRole("button", { name: "Remove all" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Remove all 2 jobs?" });
  await expectBrowser(dialog).toBeVisible();
  await drop();
  await expectBrowser(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expectBrowser(dialog).toBeHidden();
  await expectBrowser(page.getByRole("button", { name: /^Remove job / })).toHaveCount(2);
}, 30_000);

test("a dropped folder past what is read says some of its files may not have been added", async () => {
  const page = await openSubmitBatch("Batch folder dropper");
  const root = await mkdtemp(path.join(tmpdir(), "dropped-folder-"));
  onTestFinished(() => rm(root, { recursive: true }));
  const folder = path.join(root, "scans");
  await mkdir(folder);
  await Promise.all(
    Array.from({ length: 1_001 }, (_, at) => writeFile(path.join(folder, `${at}.txt`), `${at}`)),
  );
  const loose = path.join(root, "loose.txt");
  await writeFile(loose, "Loose.");
  const group = page.getByRole("group", { name: "Jobs" });
  await group.scrollIntoViewIfNeeded();
  const box = await group.boundingBox();
  if (!box) throw new Error("The Jobs group is not shown.");
  // Dropped as a person drops a folder and a file beside it, through the browser's own hit test.
  const input = await page.context().newCDPSession(page);
  const at = { x: box.x + 10, y: box.y + box.height / 2 };
  const data = { items: [], files: [folder, loose], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"] as const)
    await input.send("Input.dispatchDragEvent", { type, ...at, data });
  const words =
    "A dropped folder is read up to 1,000 files, so some of its files may not have been added.";
  await expectBrowser(page.getByLabel("Custom ID of job 1000")).toBeAttached({ timeout: 15_000 });
  await expectBrowser(page.getByLabel("Custom ID of job 1001")).toHaveCount(0);
  await expectBrowser(group.getByText(words)).toBeVisible();
  await expectBrowser(page.getByRole("status").filter({ hasText: "added" })).toContainText(words);
  // The words go with the next change of the rows.
  await page.getByRole("button", { name: "Remove job 1", exact: true }).click();
  await expectBrowser(group.getByText(words)).toHaveCount(0);
}, 60_000);

test("files alike in name, size and time but not in content are each sent as their own", async () => {
  const page = await openSubmitBatch("Batch scanner");
  await page.getByLabel("Batch ID").fill("look-alikes");
  // Dropped, so the two files can share a modification time, which the chooser does not set.
  // A string, as these tests are typed without the DOM's names.
  const transfer = await page.evaluateHandle(`(() => {
    const dropped = new DataTransfer();
    for (const text of ["first page", "other page"])
      dropped.items.add(new File([text], "scan.pdf", { lastModified: 1700000000000 }));
    return dropped;
  })()`);
  await page.getByRole("group", { name: "Jobs" }).dispatchEvent("drop", { dataTransfer: transfer });
  await page.getByLabel("Custom ID of job 2").fill("scan-2.pdf");
  const create = page.waitForRequest(isCreate);
  await page.getByRole("button", { name: "Submit Batch" }).click();
  // Each job names its own file's content.
  const sentJobs: { customId: string; files: { digest: string }[] }[] = (
    await create
  ).postDataJSON().jobs;
  expect(sentJobs.map(({ customId, files }) => [customId, files[0]?.digest])).toEqual([
    ["scan.pdf", blobRef("first page").digest],
    ["scan-2.pdf", blobRef("other page").digest],
  ]);

  await expectBrowser(page.getByRole("heading", { level: 1 })).toContainText("look-alikes");
  const held = await system.owner().blobs.check({
    files: ["first page", "other page"].map((text) => blobRef(text)),
  });
  expect(held.files.map(({ stored }) => stored)).toEqual([true, true]);
}, 30_000);
