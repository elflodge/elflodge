import {
  JOB_CANCELLED,
  JOB_PAUSED,
  JOB_SUCCEEDED,
  type JobUsage,
  type JobUsageEntry,
} from "contract";
import { Struct } from "effect";
import { afterAll, assert, beforeAll, expect, inject, test } from "vite-plus/test";
import * as z from "zod/mini";

import { DB_SCHEMA, openDatabase } from "../src/db/database.ts";
import { JobId } from "../src/db/types.ts";
import { blobRef, startSystem, submitJob, uploadContent } from "./harness.ts";

const system = startSystem();

beforeAll(() => system.start());
afterAll(() => system.stop());

const AGENT = {
  outputContract: {
    schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
  },
};

/** An Input file at `path`, of no bytes. */
function fileAt(path: string) {
  return { path, ...blobRef("") };
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
  const {
    id: keyId,
    key,
    client,
  } = await system.createApiKey({ permissions: { job: ["create", "read"] } });

  const created = await post(key, "/batches", { agent: AGENT });
  expect(created.status).toBe(200);
  const batch = z.parse(z.looseObject({ id: z.string() }), await created.json());
  // A file's bytes are uploaded first, as the request's body, and the job names them by digest.
  const report = new TextEncoder().encode("Revenue grew 4%.");
  const ref = blobRef(report);
  const uploaded = await system.hub.fetch(`/blobs/${ref.digest}`, {
    method: "PUT",
    headers: { "x-api-key": key, "content-type": "application/octet-stream" },
    body: report,
  });
  expect(uploaded.status).toBe(200);
  expect(await uploaded.json()).toEqual(ref);
  const files = [{ path: "q3.md", ...ref }];
  const response = await post(key, `/batches/${batch.id}/jobs`, { jobs: [{ ...JOB, files }] });
  expect(response.status).toBe(200);
  const added = z.parse(
    z.object({
      batch: z.looseObject({ id: z.string() }),
      jobs: z.array(z.looseObject({ job: z.looseObject({ id: z.string() }) })),
    }),
    await response.json(),
  );
  expect(added.batch).toMatchObject({ id: batch.id, jobCounts: { queued: 1 } });
  const [first] = added.jobs;
  assert(first, "The add answered without the job");
  // The answer names the job; a read gives the rest.
  expect(first).toEqual({ created: true, job: { id: first.job.id, customId: "report-q3" } });
  const unused = { totalTokens: 0, cost: { totalUsd: 0 } };
  // The hub's default limits.
  const limits = { runTimeoutSeconds: 30 * 60, modelBudgetUsd: 1 };
  const job = {
    id: first.job.id,
    createdAt: expect.any(Date),
    status: "queued",
    startedAt: null,
    endedAt: null,
    usage: unused,
    toolCalls: {},
    ...limits,
    batchId: batch.id,
    customId: "report-q3",
    labels: {},
    // Not yet sent to a Runner, so it shows none and no report.
    lastReportedAt: null,
    submitter: { kind: "key", id: keyId, name: "jobs" },
  };
  const read = await client.jobs.get({ id: job.id });
  expect(read).toEqual(job);
  expect(await system.owner().jobs.get({ id: job.id })).toEqual(read);
});

test("a Batch and its job show the key that submitted them after revocation, and keep who created the key", async () => {
  const { id: keyId, client } = await system.createApiKey({
    name: "nightly batch",
    permissions: { job: ["create"] },
  });
  const { id, batchId } = await submitJob(client, { ...AGENT, ...JOB });
  assert(batchId !== undefined, "The job has no Batch");
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
  assert(session, "The owner has no session");
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
  const ref = blobRef(report);
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
  assert(added, "The add answered without the job");
  const owner = system.owner();
  expect((await owner.jobs.get({ id: added.job.id })).submitter).toEqual(submitter);
  expect((await owner.batches.get({ id: batch.id })).submitter).toEqual(submitter);
});

test("a key adds and reads jobs only with the permission for each", async () => {
  const { client: addOnly } = await system.createApiKey({ permissions: { job: ["create"] } });
  const { id, batchId } = await submitJob(addOnly, { ...AGENT, ...JOB });
  assert(batchId !== undefined, "The job has no Batch");

  await expect(addOnly.jobs.get({ id })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(addOnly.jobs.events({ id })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(addOnly.batches.get({ id: batchId })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  const { client: readOnly } = await system.createApiKey({ permissions: { job: ["read"] } });
  await expect(readOnly.batches.create({ agent: AGENT })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(readOnly.batches.addJobs({ id: batchId, jobs: [JOB] })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

test("an invalid Output contract or Input file path is refused with 400", async () => {
  const { key, client } = await system.createApiKey({ permissions: { job: ["create"] } });
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
  // A path cannot be given twice, nor be both a file and a folder in one job. Each use of a repeated
  // path is refused, the first included, and a path inside a file is refused once for each such file.
  const twice = 'Must be unique in the job: "a.txt" is given more than once';
  const inPhotos = 'Must not be in "photos", which is given as a file in the job';
  const inYear = 'Must not be in "photos/2026", which is given as a file in the job';
  for (const [paths, errors] of [
    [
      ["a.txt", "a.txt"],
      [
        { pointer: "/jobs/0/files/0/path", detail: twice },
        { pointer: "/jobs/0/files/1/path", detail: twice },
      ],
    ],
    [["photos", "photos/front.jpg"], [{ pointer: "/jobs/0/files/1/path", detail: inPhotos }]],
    [
      ["photos/2026/front.jpg", "photos", "photos/2026"],
      [
        { pointer: "/jobs/0/files/0/path", detail: inPhotos },
        { pointer: "/jobs/0/files/0/path", detail: inYear },
        { pointer: "/jobs/0/files/2/path", detail: inPhotos },
      ],
    ],
  ] as const) {
    await expect(
      client.batches.addJobs({ id: batch.id, jobs: [{ ...JOB, files: paths.map(fileAt) }] }),
    ).rejects.toMatchObject({ cause: { status: 400, errors } });
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

/**
 * pi's usage of one model or tool: `input` tokens in and `output` out, priced in binary fractions
 * of a dollar.
 */
function piUsage(input: number, output: number, extra: { reasoning?: number } = {}) {
  const cost = { input: input / 4096, output: output / 1024, cacheRead: 0, cacheWrite: 0 };
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    ...extra,
    totalTokens: input + output,
    cost: { ...cost, total: cost.input + cost.output },
  };
}

/**
 * pi's entry of a finished call of `toolName`, with a diagnostic of pi's harness of `code` when
 * given, as for a call that failed or never ran.
 */
function toolResult(toolName: string, code?: string) {
  return {
    kind: "pi.tool-result",
    model: [
      {
        role: "toolResult",
        toolCallId: crypto.randomUUID(),
        toolName,
        content: [],
        isError: code !== undefined,
        timestamp: Date.now(),
      },
    ],
    data: { diagnostics: code === undefined ? [] : [{ severity: "error", code, message: code }] },
  };
}

/**
 * The job's Usage records in order, each with its use by model and by tool and whether those
 * entries add up, exactly, as `numeric` in SQL, to its own `totalTokens` and `costUsd`.
 */
async function usageRecordsOf(jobId: string) {
  await using database = openDatabase(inject("databaseUrl"));
  return await database
    .withSchema(DB_SCHEMA)
    .selectFrom("usageRecord as u")
    .select((eb) => {
      const entriesOf = (map: "models" | "tools") =>
        eb
          .selectFrom(
            eb
              .fn<{ value: JobUsageEntry }>("jsonb_each", [eb.ref("u.usage", "->").key(map)])
              .as("entry"),
          )
          .select("entry.value");
      const sums = eb
        .selectFrom(entriesOf("models").unionAll(entriesOf("tools")).as("entry"))
        .select((sum) =>
          sum
            .and([
              sum(
                sum.fn.coalesce(
                  sum.fn.sum(sum.cast(sum.ref("entry.value", "->>").key("totalTokens"), "bigint")),
                  sum.lit(0),
                ),
                "=",
                sum.ref("u.totalTokens"),
              ),
              sum(
                sum.fn.coalesce(
                  sum.fn.sum(
                    sum.cast(sum.ref("entry.value", "->>").key("cost").key("total"), "numeric"),
                  ),
                  sum.lit(0),
                ),
                "=",
                sum.ref("u.costUsd"),
              ),
            ])
            .as("addsUp"),
        );
      return ["u.usage", sums.as("entriesAddUp"), "u.toolCalls"];
    })
    .where("u.jobId", "=", JobId(jobId))
    .orderBy("u.id")
    .execute();
}

/** The usage and tool calls the job's records count, and its usage and tool calls now. */
async function recordedUsageOf(jobId: string) {
  await using database = openDatabase(inject("databaseUrl"));
  return await database
    .withSchema(DB_SCHEMA)
    .selectFrom("job")
    .innerJoin("jobProgress", "jobProgress.jobId", "job.id")
    .select([
      "job.recordedUsage",
      "jobProgress.usage",
      "job.recordedToolCalls",
      "jobProgress.toolCalls",
    ])
    .where("job.id", "=", JobId(jobId))
    .executeTakeFirstOrThrow();
}

test("each end a Runner reports records what the job used since its previous end, by model and by tool, adding up to the record's totals", async () => {
  const client = await system.clientWithNewJobsKey();
  const { id } = await submitJob(client, { ...AGENT, input: "Summarise." });
  const runner = await system.connectReportingRunner();
  const first = await runner.place(id);
  await runner.start(first, { models: { "scripted/small": piUsage(1024, 64) }, tools: {} });
  // The ending report itself carries new usage: the record counts it.
  const firstEnd = {
    models: { "scripted/small": piUsage(2048, 128) },
    // `reasoning`, given here and not at the next end, stays out of that end's entry.
    tools: { web_search: { totalTokens: 1, reasoning: 1, cost: { total: 0.1 } } },
  };
  await runner.report(
    { ...first, position: 1 },
    [toolResult("web_search"), { kind: JOB_CANCELLED }],
    firstEnd,
  );

  // The resumed run uses another model and the tool again, and the first model no more.
  await client.jobs.resume({ id });
  const second = await runner.place(id);
  const finished = { kind: JOB_SUCCEEDED, data: { output: { summary: "Done." } } };
  const calls = [toolResult("web_search"), toolResult("web_search"), toolResult("bash")];
  await runner.report(second, [...calls, finished], {
    models: {
      "scripted/small": piUsage(2048, 128),
      "scripted/large": piUsage(4096, 256, { reasoning: 32 }),
    },
    tools: { web_search: { totalTokens: 3, cost: { total: 0.3 } } },
  });
  runner.close();

  expect(await usageRecordsOf(id)).toEqual([
    { usage: firstEnd, entriesAddUp: true, toolCalls: { web_search: 1 } },
    {
      usage: {
        models: { "scripted/large": piUsage(4096, 256, { reasoning: 32 }) },
        // Exactly 0.2, as `numeric` subtracts, where JavaScript's 0.3 - 0.1 is not.
        tools: { web_search: { totalTokens: 2, cost: { total: 0.2 } } },
      },
      entriesAddUp: true,
      // Only the resumed run's calls.
      toolCalls: { web_search: 2, bash: 1 },
    },
  ]);
});

test.each([
  { end: "a cancel of the paused job", paused: true },
  { end: "a cancel of its paused job's Batch", paused: true },
  { end: "its Runner's removal", paused: false },
])(
  "an end by $end records what the job used since its previous end, by model and by tool, adding up to the record's totals",
  async ({ end, paused }) => {
    const client = await system.clientWithNewJobsKey();
    const { id, batchId } = await submitJob(client, { ...AGENT, input: "Summarise." });
    const runner = await system.connectReportingRunner();
    // A first end the Runner reports, so the hub's end counts from it.
    const first = await runner.place(id);
    const firstEnd = {
      models: { "scripted/small": piUsage(1024, 64) },
      tools: { web_search: piUsage(512, 0) },
    };
    await runner.start(first, firstEnd, [toolResult("web_search"), { kind: JOB_CANCELLED }]);
    await client.jobs.resume({ id });
    const second = await runner.place(id);
    const used = {
      // `reasoning` first reported in this run counts in full.
      models: { "scripted/small": piUsage(3072, 64, { reasoning: 16 }) },
      tools: { web_search: piUsage(512, 0) },
    };
    await runner.report(
      second,
      [toolResult("web_search"), ...(paused ? [{ kind: JOB_PAUSED }] : [])],
      used,
    );
    if (end === "a cancel of the paused job") await client.jobs.cancel({ id });
    else if (paused) await client.batches.cancel({ id: batchId });
    else await system.owner().runners.delete({ id: runner.runnerId });
    runner.close();

    expect((await client.jobs.get({ id })).status).toBe(paused ? "cancelled" : "failed");
    expect(await usageRecordsOf(id)).toEqual([
      { usage: firstEnd, entriesAddUp: true, toolCalls: { web_search: 1 } },
      {
        usage: { models: { "scripted/small": piUsage(2048, 0, { reasoning: 16 }) }, tools: {} },
        entriesAddUp: true,
        // Only the resumed run's call.
        toolCalls: { web_search: 1 },
      },
    ]);
    // Its next end counts from here.
    expect(await recordedUsageOf(id)).toEqual({
      recordedUsage: used,
      usage: used,
      recordedToolCalls: { web_search: 2 },
      toolCalls: { web_search: 2 },
    });
  },
);

test("an end leaves out a stored counter that is not a number, or a token count that is not whole, and is recorded", async () => {
  const client = await system.clientWithNewJobsKey();
  const { id } = await submitJob(client, { ...AGENT, input: "Summarise." });
  // A Runner of the older protocol could store any counter beside `totalTokens` and `cost.total`.
  const counted = piUsage(1024, 64);
  const stored = {
    models: {
      "scripted/small": {
        ...counted,
        input: "unknown",
        cacheRead: 1.5,
        cost: { ...counted.cost, input: "7" },
      },
    },
    tools: {},
  };
  {
    await using database = openDatabase(inject("databaseUrl"));
    await database
      .withSchema(DB_SCHEMA)
      .updateTable("jobProgress")
      .set((eb) => ({
        usage: eb.cast<JobUsage>(eb.val(JSON.stringify(stored)), "jsonb"),
        totalTokens: counted.totalTokens,
        costUsd: counted.cost.total,
      }))
      .where("jobId", "=", JobId(id))
      .execute();
  }
  await client.jobs.cancel({ id });

  expect((await client.jobs.get({ id })).status).toBe("cancelled");
  expect(await usageRecordsOf(id)).toEqual([
    {
      usage: {
        models: {
          "scripted/small": {
            ...Struct.omit(counted, ["input", "cacheRead"]),
            cost: Struct.omit(counted.cost, ["input"]),
          },
        },
        tools: {},
      },
      entriesAddUp: true,
      toolCalls: {},
    },
  ]);
});

test("a job counts each tool call its Events record as finished once, but not one that never ran", async () => {
  const client = await system.clientWithNewJobsKey();
  const { id } = await submitJob(client, { ...AGENT, input: "Summarise." });
  expect((await client.jobs.get({ id })).toolCalls).toEqual({});
  const runner = await system.connectReportingRunner();
  const run = await runner.place(id);
  const usage = { models: {}, tools: {} };
  await runner.start(run, usage);
  const calls = [
    toolResult("web_search"),
    // Refused before it ran, as the Runner's web-access guard refuses a call.
    toolResult("web_search", "blocked"),
    // Ran and failed.
    toolResult("bash", "tool_error"),
    // An entry the hub cannot read counts as nothing.
    { kind: "pi.tool-result", model: [{ role: "toolResult" }] },
  ];
  await runner.report({ ...run, position: 1 }, calls, usage);
  // Sent again, as after an answer that was lost.
  await runner.report({ ...run, position: 1 }, calls, usage);
  runner.close();

  expect((await client.jobs.get({ id })).toolCalls).toEqual({ web_search: 1, bash: 1 });
});

test("a Batch adds up its jobs' tool calls by tool name, counting each job once", async () => {
  const client = await system.clientWithNewJobsKey();
  const batch = await client.batches.create({ agent: AGENT, breaker: false });
  const { jobs } = await client.batches.addJobs({
    id: batch.id,
    jobs: [
      { customId: "first", input: "Summarise." },
      { customId: "second", input: "Summarise." },
    ],
  });
  const runner = await system.connectReportingRunner();
  const usage = { models: { "scripted/small": piUsage(1024, 64) }, tools: {} };
  const calls = [
    [toolResult("web_search"), toolResult("web_search"), toolResult("bash")],
    [toolResult("web_search"), toolResult("read")],
  ];
  for (const [index, { job }] of jobs.entries()) {
    const run = await runner.place(job.id);
    await runner.start(run, usage, calls[index]);
  }
  runner.close();

  expect(await client.batches.get({ id: batch.id })).toMatchObject({
    jobCounts: { running: 2 },
    usage: { totalTokens: 2 * 1088, cost: { totalUsd: 2 * 0.3125 } },
    toolCalls: { web_search: 3, bash: 1, read: 1 },
  });
});
