import { hash } from "node:crypto";

import { afterAll, beforeAll, expect, inject, test } from "vite-plus/test";
import * as z from "zod/mini";

import { DB_SCHEMA, openDatabase } from "../src/db/database.ts";
import { JobId } from "../src/db/types.ts";
import { startSystem, submitJob, uploadContent } from "./harness.ts";

const system = startSystem();

beforeAll(() => system.start());
afterAll(() => system.stop());

const AGENT = {
  outputContract: {
    schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
  },
};
/** The digest of no bytes. */
const EMPTY = `sha256:${hash("sha256", "")}`;

/** An Input file at `path`, of no bytes. */
function fileAt(path: string) {
  return { path, digest: EMPTY, sizeBytes: 0 };
}

const JOB = { customId: "report-q3", input: "Summarise the report in one sentence." };

/** Posts `body` as raw JSON to `path` with `key`, as any HTTP client would. */
function post(key: string, path: string, body: unknown) {
  return system.hub.fetch(path, {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a Batch is created and a job added to it, each with 200, and the job reads back as queued, with a key or a member's session", async () => {
  const { id: keyId, key, client } = await system.withKey({ job: ["create", "read"] });

  const created = await post(key, "/batches", { agent: AGENT });
  expect(created.status).toBe(200);
  const batch = z.parse(z.looseObject({ id: z.string() }), await created.json());
  // A file's bytes are uploaded first, as the request's body, and the job names them by digest.
  const report = new TextEncoder().encode("Revenue grew 4%.");
  const digest = `sha256:${hash("sha256", report)}`;
  const uploaded = await system.hub.fetch(`/blobs/${digest}`, {
    method: "PUT",
    headers: { "x-api-key": key, "content-type": "application/octet-stream" },
    body: report,
  });
  expect(uploaded.status).toBe(200);
  expect(await uploaded.json()).toEqual({ digest, sizeBytes: report.length });
  const files = [{ path: "q3.md", digest, sizeBytes: report.length }];
  const response = await post(key, `/batches/${batch.id}/jobs`, { jobs: [{ ...JOB, files }] });
  expect(response.status).toBe(200);
  const added = z.parse(
    z.object({
      batch: z.looseObject({ id: z.string() }),
      jobs: z.array(
        z.object({
          created: z.boolean(),
          job: z.looseObject({ id: z.string(), createdAt: z.string() }),
        }),
      ),
    }),
    await response.json(),
  );
  expect(added.batch).toMatchObject({ id: batch.id, jobCounts: { queued: 1 } });
  const [first] = added.jobs;
  if (!first) throw new Error("The add answered without the job");
  const unused = { totalTokens: 0, cost: { totalUsd: 0 } };
  // The hub's default limits.
  const limits = { runTimeoutSeconds: 30 * 60, modelBudgetUsd: 1 };
  const job = {
    id: first.job.id,
    status: "queued",
    startedAt: null,
    endedAt: null,
    usage: unused,
    ...limits,
    batchId: batch.id,
    customId: "report-q3",
    labels: {},
    // Not yet sent to a Runner, so it shows none and no report.
    lastReportedAt: null,
    submitter: { kind: "key", id: keyId, name: "jobs" },
  };
  expect(first).toEqual({ created: true, job: { ...job, createdAt: expect.any(String) } });

  const read = { ...job, createdAt: new Date(first.job.createdAt) };
  expect(await client.jobs.get({ id: job.id })).toEqual(read);
  expect(await system.owner().jobs.get({ id: job.id })).toEqual(read);
});

test("a Batch and its job show the key that submitted them after revocation, and keep who created the key", async () => {
  const { id: keyId, client } = await system.withKey({ job: ["create"] }, "nightly batch");
  const { id, batchId } = await submitJob(client, { ...AGENT, ...JOB });
  if (batchId === undefined) throw new Error("The job has no Batch");
  await system.owner().apiKeys.revoke({ id: keyId });

  const submitter = { kind: "key", id: keyId, name: "nightly batch" };
  const owner = system.owner();
  expect((await owner.jobs.get({ id })).submitter).toEqual(submitter);
  expect((await owner.batches.get({ id: batchId })).submitter).toEqual(submitter);
  expect((await owner.jobs.list({ batchId })).jobs.map((job) => job.submitter)).toEqual([
    submitter,
  ]);
  expect(
    (await owner.batches.list({})).batches.find((batch) => batch.id === batchId),
  ).toMatchObject({
    submitter,
  });

  const session = await system.ownerAuth().getSession();
  if (!session) throw new Error("The owner has no session");
  // No API shows who created the key, so the test reads it where the hub keeps it.
  await using db = openDatabase(inject("databaseUrl"));
  expect(
    await db
      .withSchema(DB_SCHEMA)
      .selectFrom("job")
      .select("keyCreatorUserId")
      .where("id", "=", JobId(id))
      .executeTakeFirst(),
  ).toEqual({ keyCreatorUserId: session.user.id });
});

test("a member's session submits as a key does: Blobs, a Batch and its jobs, shown as the member's", async () => {
  const name = "Sam Submitter";
  const { client: member, userId } = await system.addMember({
    email: "submitter@example.com",
    name,
  });
  const submitter = { kind: "member", id: userId, name };

  const report = new TextEncoder().encode("Costs fell 2%.");
  const ref = {
    digest: `sha256:${hash("sha256", report)}`,
    sizeBytes: report.length,
  };
  expect((await member.blobs.check({ files: [ref] })).files).toMatchObject([
    { ...ref, stored: false },
  ]);
  // A file, as the dashboard uploads one from a browser.
  const upload = new File([report], "q4.md", { type: "text/markdown" });
  expect(
    await member.blobs.upload({
      params: { digest: ref.digest },
      headers: { "content-length": upload.size },
      body: upload,
    }),
  ).toEqual(ref);
  expect((await member.blobs.check({ files: [ref] })).files).toEqual([{ ...ref, stored: true }]);

  const batch = await member.batches.create({ agent: AGENT });
  expect(batch.submitter).toEqual(submitter);
  const { jobs } = await member.batches.addJobs({
    id: batch.id,
    jobs: [{ ...JOB, files: [{ path: "q4.md", ...ref }] }],
  });
  const [added] = jobs;
  if (!added) throw new Error("The add answered without the job");
  expect(added.job.submitter).toEqual(submitter);
  const owner = system.owner();
  expect((await owner.jobs.get({ id: added.job.id })).submitter).toEqual(submitter);
  expect((await owner.batches.get({ id: batch.id })).submitter).toEqual(submitter);
});

test("a key adds and reads jobs only with the permission for each", async () => {
  const { client: addOnly } = await system.withKey({ job: ["create"] });
  const { id, batchId } = await submitJob(addOnly, { ...AGENT, ...JOB });
  if (batchId === undefined) throw new Error("The job has no Batch");

  await expect(addOnly.jobs.get({ id })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(addOnly.jobs.events({ id })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(addOnly.batches.get({ id: batchId })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  const { client: readOnly } = await system.withKey({ job: ["read"] });
  await expect(readOnly.batches.create({ agent: AGENT })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(readOnly.batches.addJobs({ id: batchId, jobs: [JOB] })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

test("an invalid Output contract or Input file path is refused with 400", async () => {
  const { key, client } = await system.withKey({ job: ["create"] });
  const schemas = [
    { type: 5 },
    // A list of outputs is submitted as jobs.
    { type: "array", items: { type: "string" } },
    { type: "object", properties: { a: { $ref: "https://example.com/schema" } } },
  ];
  for (const schema of schemas) {
    await expect(
      client.batches.create({ agent: { outputContract: { schema } } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
  const batch = await client.batches.create({ agent: AGENT });
  // The file's Blob is held, so only its path can be refused: at a valid path it is taken.
  await uploadContent(client, "");
  await expect(
    client.batches.addJobs({ id: batch.id, jobs: [{ ...JOB, files: [fileAt("a/b.txt")] }] }),
  ).resolves.toMatchObject({ jobs: [{ created: true }] });
  // A path is relative and stays inside `inputs`; a file name in it is valid on every system.
  for (const path of ["/etc/passwd", "../outside", "a/../../b", "./a", "a//b", "a/", "", "a\\b"]) {
    const files = [fileAt(path)];
    await expect(
      client.batches.addJobs({ id: batch.id, jobs: [{ ...JOB, files }] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
  // A path cannot be given twice, nor be a file and a folder in one request.
  for (const paths of [
    ["a.txt", "a.txt"],
    ["photos", "photos/front.jpg"],
    ["photos/front.jpg", "photos"],
  ]) {
    await expect(
      client.batches.addJobs({ id: batch.id, jobs: [{ ...JOB, files: paths.map(fileAt) }] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }

  // The answer names the problem, so a caller can correct the request.
  const response = await post(key, "/batches", {
    agent: { outputContract: { schema: schemas[2] } },
  });
  expect(await response.json()).toMatchObject({
    status: 400,
    detail: expect.stringContaining("agent.outputContract.schema"),
  });
});
