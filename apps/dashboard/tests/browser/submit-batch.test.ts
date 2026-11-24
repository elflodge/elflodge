import { expect, onTestFinished } from "vite-plus/test";
import { commands, userEvent } from "vite-plus/test/browser/context";

import { InvalidInput } from "../../../hub/src/invalid-input.ts";
import type { Hub } from "../hub.ts";
import { aBatch, JOB_LIMITS, jobsCounted } from "../records.ts";
import {
  advance,
  focus,
  historyIndex,
  isHidden,
  isVisible,
  readAgain,
  runClockUntil,
  test,
  type Open,
} from "./dashboard.tsx";

// Submit a Batch: rows that cannot be sent, uploads stopped, failed and tried again, leaving while
// it sends, a lost answer, and files dropped. What the hub stores from a submission is in
// tests/journeys.

/** The digest the hub names a file of `text` by. */
async function digestOf(text: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return `sha256:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Opens Submit a Batch, with the hub's limits to read. */
async function openSubmitBatch(hub: Hub, open: Open) {
  hub.jobs.limits.answers(JOB_LIMITS);
  const page = await open("batches/-/new");
  await expect.element(page.getByRole("heading", { name: "Submit a Batch" })).toBeVisible();
  return page;
}

/**
 * Gives Add files' input files of these names and texts, as its chooser does. The chooser itself is
 * the browser's, which a page cannot open for a test.
 */
async function addFiles(
  page: Awaited<ReturnType<Open>>,
  files: readonly (readonly [string, string])[],
) {
  await userEvent.upload(
    page.getByCSS('input[type="file"]'),
    files.map(([name, text]) => new File([text], name, { type: "text/plain" })),
  );
}

/** The page's alert. UI SDK keeps its shared live regions, one an alert, beside the page's main. */
const pageAlert = (page: Awaited<ReturnType<Open>>) => page.getByRole("main").getByRole("alert");

/**
 * The status UI SDK's `announce` gives `words` in, which it writes to its shared region 100 ms
 * after the page asks.
 */
async function announced(page: Awaited<ReturnType<Open>>, words: string) {
  await advance(100);
  return page.getByRole("status").filter({ hasText: words });
}

/**
 * Arranges the hub's Blobs: a check answers whether `held` has each digest, and an upload adds
 * its digest, until the test arranges uploads otherwise.
 */
function holdBlobs(hub: Hub, held: Set<string>) {
  hub.blobs.check.answers(({ files }) => ({
    files: files.map((file) =>
      held.has(file.digest)
        ? { ...file, stored: true as const }
        : {
            ...file,
            stored: false as const,
            upload: { transfer: "put", url: `/blobs/${file.digest}` },
          },
    ),
  }));
  hub.blobs.upload.answers(({ params, headers }) => {
    held.add(params.digest);
    return { digest: params.digest, sizeBytes: headers["content-length"] };
  });
}

/** The answer to a creation of the Batch `id` with `customIds` its jobs. */
function created(id: string, customIds: string[]) {
  return {
    ...aBatch(id, { jobCounts: jobsCounted({ queued: customIds.length }) }),
    jobs: customIds.map((customId, index) => ({
      created: true,
      job: { id: `0196d6a0-0000-7000-8000-${String(index).padStart(12, "0")}`, customId },
    })),
  };
}

test("what a row cannot send is told when it is added and stops Submit before anything is sent, and a repeat fixed is no longer told", async ({
  hub,
  open,
}) => {
  // The stand-in has no answer for a check, an upload or a create: one sent fails the test.
  const page = await openSubmitBatch(hub, open);
  await addFiles(page, [
    ["Report: Q3.pdf", "Q3"],
    ["scan.pdf", "first scan"],
    ["scan.pdf", "second scan"],
  ]);
  await expect
    .element(page.getByRole("cell", { name: /^Report: Q3\.pdf \d/ }))
    .toHaveAccessibleDescription(
      /Must be a relative path of file names valid on Linux, macOS and Windows/,
    );
  for (const job of [2, 3])
    await expect
      .element(page.getByLabelText(`Custom ID of job ${job}`))
      .toHaveAccessibleDescription(
        'Must be unique in the request: "scan.pdf" is given more than once',
      );
  await expect
    .element(await announced(page, "added"))
    .toHaveTextContent("3 files added as jobs 1 to 3. 3 cannot be sent: each says why at its row.");

  await page.getByRole("button", { name: "Submit Batch" }).click();
  const alert = pageAlert(page);
  await expect
    .element(alert)
    .toHaveTextContent("3 jobs cannot be sent. Each says why at its row: 1, 2, 3");

  // Fixing one use of the Custom ID ends the repeat at both rows.
  const third = page.getByLabelText("Custom ID of job 3");
  await third.fill("scan-2.pdf");
  (await third.findElement()).blur();
  for (const job of [2, 3])
    await expect
      .element(page.getByLabelText(`Custom ID of job ${job}`))
      .not.toHaveAttribute("aria-invalid", "true");
  await expect.element(alert).toHaveTextContent("1 job cannot be sent. It says why at its row: 1");
  // The link leads to the cell that carries the words.
  await alert.getByRole("link", { name: "1" }).click();
  await expect.element(page.getByRole("cell", { name: /^Report: Q3\.pdf \d/ })).toHaveFocus();
  // The alert tells what stands now.
  await page.getByRole("button", { name: "Remove job 1" }).click();
  await expect.poll(() => isHidden(alert)).toBe(true);
});

test("Submit again after a stop and after a failed upload uploads only what is missing and creates one Batch", async ({
  hub,
  open,
}) => {
  const files = [
    ["a.txt", "alpha"],
    ["b.txt", "bravo"],
    ["c.txt", "charlie"],
  ] as const;
  const digests = await Promise.all(files.map(([, text]) => digestOf(text)));
  const names = new Map(files.map(([name], at) => [digests[at], name]));
  const uploaded = () => hub.blobs.upload.calls.map(({ params }) => names.get(params.digest));
  const held = new Set<string>();
  holdBlobs(hub, held);
  const page = await openSubmitBatch(hub, open);
  await page.getByLabelText("Batch ID").fill("letters");
  await addFiles(page, files);
  const submit = page.getByRole("button", { name: "Submit Batch" });

  // First: a.txt is uploaded, and the others wait until Stop, which drops them.
  hub.blobs.upload.answers(({ params, headers }) => {
    if (names.get(params.digest) !== "a.txt") return new Promise(() => undefined);
    held.add(params.digest);
    return { digest: params.digest, sizeBytes: headers["content-length"] };
  });
  await submit.click();
  const firstUploaded = page.getByText("Uploaded 1 of 3 files", { exact: false });
  await runClockUntil(1, () => isVisible(firstUploaded));
  await page.getByRole("button", { name: "Stop" }).click();
  await expect
    .element(page.getByRole("status").filter({ hasText: "Stopped." }))
    .toHaveTextContent(
      "Stopped. No Batch was created. Submit again reads the files again and uploads only what the hub does not hold.",
    );
  expect(new Set(uploaded())).toEqual(new Set(["a.txt", "b.txt", "c.txt"]));

  // Then: b.txt fails, c.txt is uploaded, and a.txt, which the hub holds, is not sent.
  let tried = hub.blobs.upload.calls.length;
  hub.blobs.upload.answers(({ params, headers }, errors) => {
    if (names.get(params.digest) === "b.txt")
      throw errors.SERVICE_UNAVAILABLE({ message: "The hub is busy." });
    held.add(params.digest);
    return { digest: params.digest, sizeBytes: headers["content-length"] };
  });
  await submit.click();
  await runClockUntil(1, () => isVisible(pageAlert(page)));
  await expect
    .element(pageAlert(page))
    .toHaveTextContent(
      "1 file was not uploaded. No Batch was created. It says why at its row: 2 Submit again reads the files again and uploads only what the hub does not hold.",
    );
  await expect
    .element(page.getByRole("cell", { name: /^b\.txt \d/ }))
    .toHaveAccessibleDescription(/The hub is busy\./);
  expect(new Set(uploaded().slice(tried))).toEqual(new Set(["b.txt", "c.txt"]));
  expect(uploaded().slice(tried)).toHaveLength(2);

  tried = hub.blobs.upload.calls.length;
  holdBlobs(hub, held);
  hub.batches.create.answers(created("letters", ["a.txt", "b.txt", "c.txt"]));
  hub.batches.get.answers(created("letters", ["a.txt", "b.txt", "c.txt"]));
  await submit.click();
  const landed = page.getByRole("heading", { level: 1, name: /letters/ });
  await runClockUntil(1, () => isVisible(landed));
  expect(uploaded().slice(tried)).toEqual(["b.txt"]);
  expect(hub.batches.create.calls).toHaveLength(1);
  expect(
    hub.batches.create.calls[0]?.jobs?.map((job) => [job.customId, job.files[0]?.digest]),
  ).toEqual(files.map(([name], at) => [name, digests[at]]));
});

test("Leave confirmed while an upload is held sends no create", async ({ hub, open }) => {
  // The stand-in has no answer for a create: one sent fails the test.
  holdBlobs(hub, new Set());
  hub.batches.list.answers({ batches: [], hasMore: false });
  const page = await openSubmitBatch(hub, open);
  await page.getByLabelText("Batch ID").fill("left-late");
  await addFiles(page, [["left.txt", "Left while uploading."]]);
  const upload = hub.blobs.upload.hold();
  await page.getByRole("button", { name: "Submit Batch" }).click();
  await upload.arrived;
  // The session read of the next page is held, so this page stays while the next one loads.
  const session = hub.session.hold();
  await page
    .getByRole("navigation", { name: "Where this is" })
    .getByRole("link", { name: "Batches" })
    .click();
  const dialog = page.getByRole("alertdialog", { name: "Leave without submitting?" });
  await dialog.getByRole("button", { name: "Leave the page" }).click();
  // Stopped by Leave itself, while the page is still here.
  await expect.element(page.getByRole("status").filter({ hasText: "Stopped." })).toBeVisible();
  upload.release();
  session.release();
  await expect.element(page.getByRole("heading", { level: 1 })).toHaveTextContent("Batches");
});

test("after a lost answer the Batch ID field holds the ID sent: an edit cannot make a second Batch, and another ID says one may exist", async ({
  hub,
  open,
}) => {
  const page = await openSubmitBatch(hub, open);
  await page.getByRole("button", { name: "Add a job" }).click();
  await page.getByLabelText("Input of job 1").fill("Receipt 3: 4.20 EUR.");
  // The create is sent and no answer comes back, so the page cannot tell whether the hub made the
  // Batch.
  hub.batches.create.drops();
  const submit = page.getByRole("button", { name: "Submit Batch" });
  const batchId = page.getByLabelText("Batch ID");
  const alert = pageAlert(page);
  await submit.click();
  await expect.poll(() => hub.batches.create.calls).toHaveLength(1);
  const sentId = hub.batches.create.calls[0]?.id ?? "";
  await expect
    .element(alert)
    .toMatchTextContent(
      `The hub may already have a Batch under this Batch ID: ${sentId} (opens in a new tab). Submit again to find out: the same values return that Batch.`,
    );
  // The ID the page made, which the field now holds.
  await expect.element(batchId).toHaveValue(sentId);
  // The link opens the Batch beside the draft. A tab the page opens is outside the test's document,
  // so where it leads is checked, not the Batch it shows.
  const link = alert.getByRole("link", { name: sentId });
  await expect.element(link).toHaveAttribute("target", "_blank");
  await expect.element(link).toHaveAttribute("href", `/dashboard/batches/${sentId}`);
  // Removing rows here would remove nothing from that Batch, and the dialog does not say otherwise.
  await page.getByRole("button", { name: "Remove all" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Remove the job?" });
  await expect
    .element(dialog)
    .toMatchTextContent("A Batch the hub may already have keeps its jobs.");
  await expect.element(dialog).not.toMatchTextContent("not been submitted");
  await dialog.getByRole("button", { name: "Keep it" }).click();

  // An edit keeps the ID, so the hub refuses the changed Batch instead of making a second one.
  const reused = "The ID was already used for a Batch with other content";
  hub.batches.create.refuses("UNPROCESSABLE_CONTENT", {
    message: reused,
    cause: new InvalidInput({ problems: [{ message: reused, path: ["id"] }] }),
  });
  const instructions = page.getByLabelText("Instructions");
  await instructions.fill("Add up the receipt.");
  await submit.click();
  await expect.element(batchId).toHaveAttribute("aria-invalid", "true");
  // Another ID would make another Batch, which the alert says.
  await batchId.fill("receipts-again");
  await expect
    .element(alert)
    .toHaveTextContent(
      `The hub may already have a Batch from an earlier submission: ${sentId} (opens in a new tab). Submitting now goes under another Batch ID and leaves that one as it is.`,
    );
  await batchId.fill(sentId);
  await instructions.fill("");
  hub.batches.create.answers(created(sentId, ["job-1"]));
  hub.batches.get.answers(created(sentId, ["job-1"]));
  await submit.click();
  await expect.element(page.getByRole("heading", { level: 1 })).toMatchTextContent(sentId);
  // Every try went under the ID sent first.
  expect(hub.batches.create.calls.map(({ id }) => id)).toEqual([sentId, sentId, sentId]);
});

test("a Batch of typed jobs says it is being created, and leaving meanwhile says the hub may have it until it lands there", async ({
  hub,
  open,
}) => {
  hub.batches.create.answers(created("typed-only", ["job-1"]));
  hub.batches.get.answers(created("typed-only", ["job-1"]));
  const page = await openSubmitBatch(hub, open);
  await page.getByLabelText("Batch ID").fill("typed-only");
  await page.getByRole("button", { name: "Add a job" }).click();
  await page.getByLabelText("Input of job 1").fill("Receipt 4: 9.10 EUR.");
  const creation = hub.batches.create.hold();
  await page.getByRole("button", { name: "Submit Batch" }).click();
  await creation.arrived;
  await expect
    .element(page.getByRole("status").filter({ hasText: "Creating" }))
    .toHaveTextContent("Creating the Batch…");
  await page
    .getByRole("navigation", { name: "Where this is" })
    .getByRole("link", { name: "Batches" })
    .click();
  const dialog = page.getByRole("alertdialog", { name: "Leave this page?" });
  await expect
    .element(dialog)
    .toMatchTextContent(
      "The hub may already have a Batch from this page: look for it in Batches before submitting it again.",
    );
  // The Batch is made while the question is open, which gives way to it at once, while the session
  // read of the Batch's page is held, so this page stays while that one loads.
  const session = hub.session.hold();
  const entry = historyIndex();
  creation.release();
  await session.arrived;
  await expect.element(page.getByRole("alertdialog")).toHaveLength(0);
  await expect.element(page.getByCSS('[data-slot="alert-dialog-content"]')).toHaveLength(0);
  await expect.element(page.getByRole("heading", { level: 1 })).toHaveTextContent("Submit a Batch");
  session.release();
  await expect.element(page.getByRole("heading", { level: 1 })).toMatchTextContent("typed-only");
  expect(historyIndex()).toBe(entry + 1);
  await expect.element(page.getByCSS("[inert]")).toHaveLength(0);
  await expect.element(page.getByCSS('[data-slot="alert-dialog-content"]')).toHaveLength(0);
});

test("Remove all asks first: keeping keeps every job, and removing sends nothing, says so and leaves focus on Add files", async ({
  hub,
  open,
}) => {
  // The stand-in has no answer for a check, an upload or a create: one sent fails the test.
  const page = await openSubmitBatch(hub, open);
  // A submission of the page's form starts in the click that causes it, so counting them needs no
  // wait.
  let submitted = 0;
  document.querySelector("form.fields")?.addEventListener("submit", () => submitted++);
  await addFiles(page, [["note.txt", "A note."]]);
  await page.getByRole("button", { name: "Add a job" }).click();
  await page.getByLabelText("Input of job 2").fill("Typed.");
  const removeAll = page.getByRole("button", { name: "Remove all" });
  const dialog = page.getByRole("alertdialog", { name: "Remove all 2 jobs?" });
  await removeAll.click();
  await dialog.getByRole("button", { name: "Keep them" }).click();
  await expect.poll(() => isHidden(dialog)).toBe(true);
  await removeAll.click();
  await expect.element(dialog.getByRole("button", { name: "Keep them" })).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => isHidden(dialog)).toBe(true);
  await expect.element(page.getByLabelText("Custom ID of job 2")).toBeVisible();
  // Pressed without taking focus, as a click does not in Safari.
  await focus(page.getByLabelText("Input of job 2"));
  (await removeAll.findElement()).dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }),
  );
  await expect.element(dialog).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => isHidden(dialog)).toBe(true);
  await expect.element(removeAll).toHaveFocus();
  await expect.element(page.getByLabelText("Custom ID of job 2")).toBeVisible();

  // The rows go while the limits, from which the draft's figures are recomputed, are read again.
  await expect.element(page.getByLabelText("Model budget")).toHaveAccessibleDescription(/At most/);
  const limits = hub.jobs.limits.hold();
  readAgain();
  await limits.arrived;
  await removeAll.click();
  await dialog.getByRole("button", { name: "Remove 2 jobs" }).click();
  await expect.poll(() => isHidden(page.getByLabelText("Custom ID of job 1"))).toBe(true);
  await expect.element(await announced(page, "All 2 jobs removed.")).toBeVisible();
  await expect.element(page.getByCSS('[data-slot="alert-dialog-content"]')).toHaveLength(0);
  await expect.element(page.getByRole("button", { name: "Add files" })).toHaveFocus();
  limits.release();
  expect(submitted).toBe(0);
});

test("a file dropped on the Jobs group adds a job, but not while Remove all asks", async ({
  hub,
  open,
}) => {
  const page = await openSubmitBatch(hub, open);
  await page.getByRole("button", { name: "Add a job" }).click();
  const group = page.getByRole("group", { name: "Jobs" });
  // Dropped at the group's start, beside where a dialog shows.
  async function drop() {
    const folder = await commands.drop(group, { "dropped.txt": "Dropped." });
    onTestFinished(() => commands.removeDropped(folder));
  }
  await drop();
  await expect.element(page.getByLabelText("Custom ID of job 2")).toBeVisible();
  await page.getByRole("button", { name: "Remove all" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Remove all 2 jobs?" });
  await expect.element(dialog).toBeVisible();
  // UI SDK makes the page behind the dialog inert after the next paint, through an animation frame
  // and then a timer: two frames' time.
  await advance(32);
  expect(group.element().closest("[inert]")).not.toBeNull();
  await drop();
  await expect.element(dialog).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => isHidden(dialog)).toBe(true);
  await expect.element(page.getByRole("button", { name: /^Remove job / })).toHaveLength(2);
});

test("a dropped folder past what is read says some of its files may not have been added", async ({
  hub,
  open,
}) => {
  const page = await openSubmitBatch(hub, open);
  const group = page.getByRole("group", { name: "Jobs" });
  const scans = Object.fromEntries(
    Array.from({ length: 1_001 }, (_, at) => [`${at}.txt`, `${at}`]),
  );
  // A folder and a file beside it.
  const folder = await commands.drop(group, { scans, "loose.txt": "Loose." });
  onTestFinished(() => commands.removeDropped(folder));
  const words =
    "A dropped folder is read up to 1,000 files, so some of its files may not have been added.";
  await expect.element(page.getByLabelText("Custom ID of job 1000")).toBeInTheDocument();
  await expect.element(page.getByLabelText("Custom ID of job 1001")).toHaveLength(0);
  await expect.element(group.getByText(words)).toBeVisible();
  await expect.element(await announced(page, "added")).toMatchTextContent(words);
  // The words go with the next change of the rows.
  await page.getByRole("button", { name: "Remove job 1", exact: true }).click();
  await expect.element(group.getByText(words)).toHaveLength(0);
});
