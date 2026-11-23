import { createHash } from "node:crypto";

import { expect, test } from "vite-plus/test";

import { creationOf, draftFiles, fileJobs } from "../src/batch-draft.ts";

test("files alike in name, size and time but not in content are each sent as their own", async () => {
  const [first, other] = ["first page", "other page"].map(
    (text) => new File([text], "scan.pdf", { lastModified: 1_700_000_000_000 }),
  );
  if (!first || !other) throw new Error("Two files were made.");
  const [one, two] = fileJobs([first, other]);
  if (!one || !two) throw new Error("A job for each file.");
  const jobs = [one, { ...two, customId: "scan-2.pdf" }];
  // Each file is read once, so each must be kept to be read.
  const files = draftFiles(jobs);
  expect(files).toEqual([first, other]);
  const digests = new Map(
    await Promise.all(
      files.map(async (file) => {
        const hash = createHash("sha256").update(new Uint8Array(await file.arrayBuffer()));
        return [file, `sha256:${hash.digest("hex")}`] as const;
      }),
    ),
  );
  const creation = creationOf({ agent: { outputContract: { schema: {} } }, jobs }, digests);
  expect(creation.jobs).toEqual([
    {
      customId: "scan.pdf",
      files: [{ path: "scan.pdf", digest: digests.get(first), sizeBytes: 10 }],
    },
    {
      customId: "scan-2.pdf",
      files: [{ path: "scan.pdf", digest: digests.get(other), sizeBytes: 10 }],
    },
  ]);
  expect(digests.get(first)).not.toBe(digests.get(other));
});
