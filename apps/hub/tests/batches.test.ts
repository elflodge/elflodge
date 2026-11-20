import { PROBLEM_DETAILS_CONTENT_TYPE } from "contract";
import { afterAll, beforeAll, expect, onTestFinished, test } from "vite-plus/test";
import * as z from "zod/mini";

import {
  type ApiClient,
  type JobInput,
  protocolClient,
  startSystem,
  submitJob,
  untilStatus,
  uploadContent,
} from "./harness.ts";
import { callTool, reply, untilAborted } from "./scripted-model.ts";

// Batches, labels, the job list and status filters on jobs, Batches and usage, against a real hub.
// The first tests run before any Runner starts and cancel what they leave unfinished.
// The rest share the Runner the first of them starts.

const system = startSystem();

beforeAll(() => system.start());
afterAll(() => system.stop());

const AGENT = { outputContract: { schema: { type: "integer" } } };

/** A job with the custom ID `customId`. */
function jobNamed(customId: string, extra: Partial<JobInput> = {}): JobInput {
  return { customId, input: `Answer for ${customId}.`, ...extra };
}

/** What blocks each job an add answered with, or "none". */
function blockedBy(added: Awaited<ReturnType<ApiClient["batches"]["addJobs"]>>) {
  return added.jobs.map(({ job }) => job.blockedBy ?? "none");
}

/** Waits until the Batch `id` has `status`. */
async function untilBatchStatus(client: ApiClient, id: string, status: string) {
  await expect
    .poll(async () => (await client.batches.get({ id })).status, { timeout: 15_000 })
    .toBe(status);
}

/** Posts `body` as raw JSON to `path` with a new key, as any HTTP client would. */
async function post(path: string, body: unknown) {
  return system.hub.fetch(path, {
    method: "POST",
    headers: { "x-api-key": await system.newJobsKey(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("an unknown member of a job add points to the whole JSON body", async () => {
  const response = await post("/batches/example/jobs", { jobs: [jobNamed("a")], unexpected: true });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ errors: [{ pointer: "" }] });
});

test("a Batch refuses NUL in an Output contract's schema", async () => {
  for (const schema of [{ description: "a\0b" }, { properties: { "a\0b": {} } }]) {
    const response = await post("/batches", { agent: { outputContract: { schema } } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      errors: [
        {
          pointer: "/agent/outputContract/schema",
          detail: "The schema's text must not contain NUL",
        },
      ],
    });
  }
});

test("an ID used again with the same content returns what it named, whoever repeats it, and with other content is refused", async () => {
  const { id: keyId, client } = await system.createApiKey({
    name: "invoices",
    permissions: { job: ["create", "read", "cancel"] },
  });
  const byKey = { kind: "key", id: keyId, name: "invoices" };
  const { client: member, userId } = await system.addMember({
    email: "retrier@example.com",
    name: "Rae Retrier",
  });
  const creation = { id: "invoices-2026-10", agent: AGENT, breaker: false } as const;
  const batch = await client.batches.create(creation);
  expect(batch).toMatchObject({
    id: "invoices-2026-10",
    status: "active",
    breaker: false,
    jobs: [],
  });
  // The script runs again, from the start, by a member: the same Batch, still the key's, as IDs
  // belong to the Organization.
  expect(await member.batches.create(creation)).toMatchObject({ id: batch.id, submitter: byKey });
  await expect(client.batches.create({ ...creation, breaker: true })).rejects.toMatchObject({
    code: "UNPROCESSABLE_CONTENT",
    cause: { errors: [{ pointer: "/id" }] },
  });
  // An ID differing only in case names another Batch.
  expect((await client.batches.create({ ...creation, id: "Invoices-2026-10" })).id).toBe(
    "Invoices-2026-10",
  );
  // Without one, the hub makes a UUID.
  expect((await client.batches.create({ agent: AGENT })).id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  // An ID outside the syntax is refused, given to create a Batch or to name one.
  for (const id of ["-invoices", "invoices 2026", "x".repeat(101), ""]) {
    expect((await post("/batches", { id, agent: AGENT })).status).toBe(400);
  }
  const named = await system.hub.fetch("/batches/invoices.2026", {
    headers: { "x-api-key": await system.newJobsKey() },
  });
  expect(named.status).toBe(400);
  expect(await named.json()).toMatchObject({ errors: [{ parameter: "id" }] });

  const first = await client.batches.create({
    ...creation,
    jobs: [jobNamed("a"), jobNamed("b")],
  });
  expect(first.jobs.map(({ created, job }) => [job.customId, created])).toEqual([
    ["a", true],
    ["b", true],
  ]);
  // Again, by the member, with a job the Batch lacks: the jobs it has are returned as the key added
  // them, and only the one it lacks added, as the member's.
  const again = await member.batches.addJobs({
    id: batch.id,
    jobs: [jobNamed("a"), jobNamed("c"), jobNamed("b")],
  });
  expect(again.jobs.map(({ created, job }) => [job.customId, created])).toEqual([
    ["a", false],
    ["c", true],
    ["b", false],
  ]);
  expect(again.jobs[0]?.job.id).toBe(first.jobs[0]?.job.id);
  expect(again.jobs.map(({ job }) => job.submitter)).toEqual([
    byKey,
    { kind: "member", id: userId, name: "Rae Retrier" },
    byKey,
  ]);
  expect(again.batch.submitter).toEqual(byKey);
  expect(again.batch.jobCounts).toMatchObject({ queued: 3 });

  // A custom ID used for a job with other content refuses the whole add, naming each such job.
  const response = await post(`/batches/${batch.id}/jobs`, {
    jobs: [jobNamed("d"), jobNamed("b", { input: "Something else." })],
  });
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({
    detail: expect.stringContaining("jobs[1].customId"),
    errors: [
      {
        pointer: "/jobs/1/customId",
        detail: "Already used in the Batch for a job with other content",
      },
    ],
  });
  expect((await client.batches.get({ id: batch.id })).jobCounts).toMatchObject({ queued: 3 });
  await client.batches.cancel({ id: batch.id });
});

test("a refused creation leaves the Batch ID free, including when a job names an unheld Blob", async () => {
  const client = await system.clientWithNewJobsKey();
  const id = "atomic";
  const jobs = [
    jobNamed("first"),
    jobNamed("second", {
      files: [{ path: "rates.csv", digest: `sha256:${"0".repeat(64)}`, sizeBytes: 3 }],
    }),
  ];
  await expect(client.batches.create({ id, agent: AGENT, jobs })).rejects.toMatchObject({
    cause: { status: 400, errors: [{ pointer: "/jobs/1/files/0/digest" }] },
  });
  await expect(client.batches.get({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  const response = await post("/batches", {
    id,
    agent: { outputContract: { schema: { type: "array" } } },
    jobs: [{ customId: "first" }],
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    errors: [{ pointer: "/agent/outputContract/schema" }, { pointer: "/jobs/0/input" }],
  });
});

test("an add with an invalid job adds none, and its answer names every problem with its path", async () => {
  const client = await system.clientWithNewJobsKey();
  const batch = await client.batches.create({
    agent: AGENT,
    labels: { team: "billing" },
    breaker: false,
  });
  const many = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`l${index}`, "x"]));

  // Problems only the hub sees, with the Batch: a custom ID given twice, labels over the limit with
  // the Batch's, and a job with neither input nor files.
  const pendingJobAdd = client.batches.addJobs({
    id: batch.id,
    jobs: [jobNamed("a"), jobNamed("a"), jobNamed("c", { labels: many }), { customId: "d" }],
  });
  for (const path of ["jobs[1].customId", "jobs[2].labels", "jobs[3].input"]) {
    await expect(pendingJobAdd).rejects.toMatchObject({
      cause: { status: 400, detail: expect.stringContaining(path) },
    });
  }

  // Files whose content the Organization never uploaded, or of a size other than its content's.
  const rates = await uploadContent(client, "2.2");
  const pendingFileAdd = client.batches.addJobs({
    id: batch.id,
    jobs: [
      jobNamed("e", { files: [{ path: "rates.csv", ...rates }] }),
      jobNamed("f", {
        files: [{ path: "rates.csv", ...rates, digest: `sha256:${"0".repeat(64)}` }],
      }),
      jobNamed("g", { files: [{ path: "rates.csv", ...rates, sizeBytes: rates.sizeBytes + 1 }] }),
    ],
  });
  for (const detail of [
    expect.stringContaining("jobs[1].files[0].digest"),
    expect.stringContaining("jobs[2].files[0].sizeBytes"),
    expect.not.stringContaining("jobs[0]"),
  ]) {
    await expect(pendingFileAdd).rejects.toMatchObject({ cause: { status: 400, detail } });
  }

  // The wire pointer escapes each token. The client restores even an invalid Label key verbatim.
  await expect(
    client.batches.addJobs({
      id: batch.id,
      jobs: [jobNamed("d", { labels: { "team/~name": "ok" } })],
    }),
  ).rejects.toMatchObject({
    cause: { errors: [{ pointer: "/jobs/0/labels/team~1~0name" }] },
    data: { issues: [{ path: ["jobs", "0", "labels", "team/~name"] }] },
  });

  // A label value holds any text of at most 256 characters, but no NUL.
  const invalid = await post(`/batches/${batch.id}/jobs`, {
    jobs: [
      jobNamed("d", { labels: { note: "é".repeat(256) } }),
      jobNamed("e", { labels: { note: "\0" } }),
    ],
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ detail: expect.stringContaining("jobs[1].labels") });
  expect((await client.batches.get({ id: batch.id })).jobCounts).toMatchObject({ queued: 0 });
  await client.batches.cancel({ id: batch.id });
});

test("a job naming a field the API does not know, such as the old `inputFiles`, is refused, not run without it", async () => {
  const client = await system.clientWithNewJobsKey();
  const batch = await client.batches.create({ agent: AGENT, breaker: false });

  const refused = await post(`/batches/${batch.id}/jobs`, {
    jobs: [jobNamed("a"), { ...jobNamed("b"), inputFiles: {} }],
  });
  expect(refused.status).toBe(400);
  const { detail } = z.parse(z.object({ detail: z.string() }), await refused.json());
  expect(detail).toContain('"inputFiles"');
  expect(detail).toContain("jobs[1]");
  expect((await client.batches.get({ id: batch.id })).jobCounts).toMatchObject({ queued: 0 });
  await client.batches.cancel({ id: batch.id });
});

test("jobs are listed by label, status, Batch and custom ID, newest first, with a Batch's labels beneath their own", async () => {
  const client = await system.clientWithNewJobsKey();
  const batch = await client.batches.create({
    agent: AGENT,
    labels: { customer: "acme", team: "billing" },
    breaker: false,
  });
  await client.batches.addJobs({
    id: batch.id,
    jobs: [jobNamed("x", { labels: { team: "support" } }), jobNamed("y")],
  });
  const alone = await submitJob(client, {
    ...AGENT,
    customId: "alone",
    input: "Alone.",
    labels: { customer: "acme" },
  });
  await client.jobs.cancel({ id: alone.id });

  const jobs = await client.jobs.list({ batchId: batch.id });
  expect(jobs.jobs.map((listed) => [listed.customId, listed.labels])).toEqual([
    ["y", { customer: "acme", team: "billing" }],
    ["x", { customer: "acme", team: "support" }],
  ]);

  const acme = await client.jobs.list({ labels: { customer: "acme" }, limit: 2 });
  expect(acme.jobs.map((listed) => listed.customId)).toEqual(["alone", "y"]);
  expect(acme.hasMore).toBe(true);
  const next = await client.jobs.list({ labels: { customer: "acme" }, after: alone.id, limit: 2 });
  expect(next.jobs.map((listed) => listed.customId)).toEqual(["y", "x"]);
  expect(next.hasMore).toBe(false);

  const support = await client.jobs.list({ labels: { customer: "acme", team: "support" } });
  expect(support.jobs.map((listed) => listed.customId)).toEqual(["x"]);
  const cancelled = await client.jobs.list({ labels: { customer: "acme" }, status: ["cancelled"] });
  expect(cancelled.jobs.map((listed) => listed.id)).toEqual([alone.id]);
  const either = await client.jobs.list({
    labels: { customer: "acme" },
    status: ["queued", "cancelled"],
  });
  expect(either.jobs.map((listed) => listed.customId)).toEqual(["alone", "y", "x"]);
  const neither = await client.jobs.list({
    labels: { customer: "acme" },
    status: ["failed", "running"],
  });
  expect(neither.jobs).toEqual([]);
  const named = await client.jobs.list({ customId: "x", labels: { customer: "acme" } });
  expect(named.jobs.map((listed) => listed.batchId)).toEqual([batch.id]);

  // The query string as a caller writes it by hand: one status, and a label in brackets.
  const response = await system.hub.fetch(
    `/jobs?status=queued&labels%5Bteam%5D=billing&batchId=${batch.id}`,
    { headers: { "x-api-key": await system.newJobsKey() } },
  );
  const page = z.parse(
    z.object({ jobs: z.array(z.object({ customId: z.string() })) }),
    await response.json(),
  );
  expect(page.jobs.map((listed) => listed.customId)).toEqual(["y"]);

  await client.batches.cancel({ id: batch.id });
});

test.each(["/jobs", "/batches", "/usage"])(
  "%s refuses an unknown filter and names it",
  async (path) => {
    for (const [query, name] of [
      ["statuses=queued", "statuses"],
      ["status[]=failed", "status[]"],
      ["status%5B0%5D=failed", "status[0]"],
      ["status=cancelled&status[]=failed", "status[]"],
    ] as const) {
      const response = await system.hub.fetch(`${path}?${query}`, {
        headers: { cookie: system.ownerCookie() },
      });
      expect(response.status, query).toBe(400);
      expect(response.headers.get("content-type")).toBe(PROBLEM_DETAILS_CONTENT_TYPE);
      expect(await response.json(), query).toMatchObject({
        type: "about:blank",
        title: "Bad Request",
        status: 400,
        detail: expect.stringContaining(`"${name}"`),
      });
    }
  },
);

test("Batches are listed newest first, by status and label, in pages", async () => {
  const client = await system.clientWithNewJobsKey();
  const labels = { suite: "batch-list" };
  // Newest first gives May, April, March, which differs from either alphabetical order of the IDs.
  const cancelled = await client.batches.create({
    id: "march",
    agent: AGENT,
    labels,
    breaker: false,
  });
  await client.batches.addJobs({ id: cancelled.id, jobs: [jobNamed("a")] });
  await client.batches.cancel({ id: cancelled.id });
  const paused = await client.batches.create({
    id: "april",
    agent: AGENT,
    labels: { ...labels, team: "billing" },
    breaker: false,
  });
  await client.batches.pause({ id: paused.id });
  const active = await client.batches.create({
    id: "may",
    agent: AGENT,
    labels: { ...labels, team: "ops" },
  });

  const listed = await client.batches.list({ labels });
  expect(listed.batches.map(({ id }) => id)).toEqual([active.id, paused.id, cancelled.id]);
  expect(listed.batches[2]).toMatchObject({
    status: "cancelled",
    jobCounts: { cancelled: 1, queued: 0 },
    statusUnknownJobs: 0,
  });
  expect(listed.hasMore).toBe(false);

  const first = await client.batches.list({ labels, limit: 2 });
  expect(first).toMatchObject({ batches: [{ id: active.id }, { id: paused.id }], hasMore: true });
  const next = await client.batches.list({ labels, limit: 2, after: paused.id });
  expect(next).toMatchObject({ batches: [{ id: cancelled.id }], hasMore: false });

  expect(
    await client.batches.list({ after: paused.id, labels: { ...labels, team: "ops" } }),
  ).toEqual({
    batches: [],
    hasMore: false,
  });

  for (const [status, batch] of [
    ["active", active],
    ["paused", paused],
    ["cancelled", cancelled],
  ] as const) {
    const byStatus = await client.batches.list({ labels, status: [status] });
    expect(byStatus.batches.map(({ id }) => id)).toEqual([batch.id]);
  }
  const ops = await client.batches.list({ labels: { team: "ops" } });
  expect(ops.batches.map(({ id }) => id)).toContain(active.id);
  expect(ops.batches.map(({ id }) => id)).not.toContain(paused.id);

  // A Batch's ID tells nothing of its order, so an `after` naming no Batch cannot be read on from.
  await expect(client.batches.list({ after: "no-such-batch" })).rejects.toMatchObject({
    cause: { status: 400, detail: expect.stringContaining("after") },
  });
});

test("a paused Batch blocks the jobs not yet sent and those added later, without changing their status", async () => {
  const client = await system.clientWithNewJobsKey();
  const batch = await client.batches.create({ agent: AGENT, breaker: false });
  const [first] = (await client.batches.addJobs({ id: batch.id, jobs: [jobNamed("a")] })).jobs;
  if (!first) throw new Error("The add answered without the job");

  expect(await client.batches.pause({ id: batch.id })).toMatchObject({
    status: "paused",
    pausedBy: "caller",
  });
  const added = await client.batches.addJobs({ id: batch.id, jobs: [jobNamed("b")] });
  expect(added.jobs[0]?.job).toMatchObject({ status: "queued", blockedBy: "batchPausedByCaller" });
  expect(await client.jobs.get({ id: first.job.id })).toMatchObject({
    status: "queued",
    blockedBy: "batchPausedByCaller",
  });

  expect(await client.batches.resume({ id: batch.id })).toMatchObject({ status: "active" });
  const [listed] = (await client.jobs.list({ batchId: batch.id, customId: "b" })).jobs;
  expect(listed).toMatchObject({ status: "queued" });
  expect(listed).not.toHaveProperty("blockedBy");
  await client.batches.cancel({ id: batch.id });
});

test("a cancel is final: the Batch takes no new jobs and resumes none, even with every job ended", async () => {
  const client = await system.clientWithNewJobsKey();
  const batch = await client.batches.create({ agent: AGENT, breaker: false });
  await client.batches.addJobs({ id: batch.id, jobs: [jobNamed("a")] });
  await client.batches.pause({ id: batch.id });

  const cancelled = await client.batches.cancel({ id: batch.id });
  // No Runner was sent the job, so it ends at once.
  expect(cancelled).toMatchObject({
    status: "cancelled",
    pausedBy: null,
    jobCounts: { cancelled: 1 },
  });
  expect(cancelled).not.toHaveProperty("pendingControl");
  // Both calls can recover the job after cancellation, even if the original answer was lost.
  for (const submit of [
    (jobs: JobInput[]) =>
      client.batches.create({ id: batch.id, agent: AGENT, breaker: false, jobs }),
    (jobs: JobInput[]) => client.batches.addJobs({ id: batch.id, jobs }),
  ]) {
    expect(await submit([jobNamed("a")])).toMatchObject({
      jobs: [{ created: false, job: { customId: "a", status: "cancelled" } }],
    });
    await expect(
      submit([jobNamed("b"), jobNamed("a", { input: "Changed." })]),
    ).rejects.toMatchObject({
      code: "UNPROCESSABLE_CONTENT",
      cause: { errors: [{ pointer: "/jobs/1/customId" }] },
    });
    await expect(submit([jobNamed("a"), jobNamed("b")])).rejects.toMatchObject({
      code: "CONFLICT",
    });
  }
  await expect(client.batches.resume({ id: batch.id })).rejects.toMatchObject({ code: "CONFLICT" });

  const empty = await client.batches.create({ agent: AGENT });
  expect(empty).toMatchObject({ status: "active", jobCounts: { queued: 0 } });
  expect(await client.batches.cancel({ id: empty.id })).toMatchObject({ status: "cancelled" });
  await expect(
    client.batches.addJobs({ id: empty.id, jobs: [jobNamed("a")] }),
  ).rejects.toMatchObject({
    code: "CONFLICT",
  });
});

test("a Batch's Canary, its first jobs, those added later included, runs before the rest are released", async () => {
  const client = await system.clientWithNewJobsKey();
  const batch = await client.batches.create({ agent: AGENT });
  expect(batch.breaker).toEqual({ canary: 5, maxFailurePercent: 10 });

  const first = await client.batches.addJobs({
    id: batch.id,
    jobs: [jobNamed("1"), jobNamed("2")],
  });
  expect(blockedBy(first)).toEqual(["none", "none"]);
  const rest = await client.batches.addJobs({
    id: batch.id,
    jobs: ["3", "4", "5", "6", "7"].map((customId) => jobNamed(customId)),
  });
  expect(blockedBy(rest)).toEqual(["none", "none", "none", "batchCanary", "batchCanary"]);
  await client.batches.cancel({ id: batch.id });

  // A Canary of none releases every job at once.
  const uncautious = await client.batches.create({
    agent: AGENT,
    breaker: { canary: 0, maxFailurePercent: 10 },
  });
  const all = await client.batches.addJobs({
    id: uncautious.id,
    jobs: [jobNamed("1"), jobNamed("2")],
  });
  expect(blockedBy(all)).toEqual(["none", "none"]);
  await client.batches.cancel({ id: uncautious.id });
});

test("Batch reads count blocked jobs through a pause and a new Canary at the end of the queue", async () => {
  const client = await system.clientWithNewJobsKey();
  const labels = { series: "tail-canary" };
  const { id } = await client.batches.create({
    agent: AGENT,
    labels,
    breaker: { canary: 2, maxFailurePercent: 100 },
  });
  onTestFinished(async () => {
    await client.batches.cancel({ id });
  });
  const { jobs } = await client.batches.addJobs({
    id,
    jobs: ["first", "second", "older", "next", "newest"].map((name) => jobNamed(name)),
  });
  const [, , older, next, newest] = jobs.map(({ job }) => job.id);
  if (!older || !next || !newest) throw new Error("The add answered without the jobs");

  async function counts(expected: {
    batchCanary?: number;
    batchPausedByCaller?: number;
    batchPausedByBreaker?: number;
  }) {
    const batch = await client.batches.get({ id });
    expect(batch.blockedJobCounts).toEqual({
      batchPausedByCaller: 0,
      batchPausedByBreaker: 0,
      batchCanary: 0,
      ...expected,
    });
    const [listed] = (await client.batches.list({ labels })).batches;
    expect(listed?.blockedJobCounts).toEqual(batch.blockedJobCounts);
  }
  await counts({ batchCanary: 3 });
  await client.jobs.pause({ id: older });

  // Placement alone leaves both Canary jobs queued. Neither counts under the caller's pause,
  // and the second still does not count when the first job's failure trips the breaker.
  const { socket, runnerId } = await system.connectRunner();
  onTestFinished(async () => {
    socket.close(1000);
    await system.owner().runners.delete({ id: runnerId });
  });
  const runner = protocolClient(socket);
  const { runs } = await runner.request("sync", { held: [], free: 2 }, 10_000);
  const held = runs.map(({ jobId, runId }) => ({ jobId, runId }));
  const [first] = held;
  expect(new Set(held.map(({ jobId }) => jobId))).toEqual(
    new Set(jobs.slice(0, 2).map(({ job }) => job.id)),
  );
  if (!first) throw new Error("The Runner received no job");
  await client.batches.pause({ id });
  await counts({ batchPausedByCaller: 2 });
  await client.batches.resume({ id });
  await runner.request(
    "report",
    {
      held,
      free: 0,
      deleted: [],
      jobs: [
        {
          ...first,
          position: 0,
          intent: "run",
          events: [],
          failure: {
            timestamp: Date.now(),
            reason: "runFaulted",
            message: "The journal could not be opened",
          },
        },
      ],
    },
    10_000,
  );
  await counts({ batchPausedByBreaker: 2 });

  await client.batches.resume({ id });
  expect(await client.jobs.resume({ id: older })).toMatchObject({ blockedBy: "batchCanary" });
  const [latest] = (await client.jobs.list({ batchId: id, status: ["queued"], limit: 1 })).jobs;
  expect(latest?.id).toBe(newest);
  // The newest queued job is free while the older resumed job is blocked.
  expect(latest).not.toHaveProperty("blockedBy");
  await counts({ batchCanary: 1 });

  await client.jobs.cancel({ id: next });
  await client.jobs.cancel({ id: newest });
  await counts({});
  expect(await client.jobs.get({ id: older })).not.toHaveProperty("blockedBy");
});

test("a failure in the Canary pauses the Batch, and resuming it runs a new Canary of the next jobs first, those added later included", async () => {
  await system.startRunner();
  // Every job's model call fails, as when a budget every job shares is set too low.
  system.model.setResponses([]);
  const client = await system.clientWithNewJobsKey();
  const batch = await client.batches.create({
    agent: AGENT,
    breaker: { canary: 1, maxFailurePercent: 100 },
  });
  const { jobs } = await client.batches.addJobs({
    id: batch.id,
    jobs: [jobNamed("1"), jobNamed("2"), jobNamed("3")],
  });
  const [, second, third] = jobs.map(({ job }) => job.id);
  if (!second || !third) throw new Error("The add answered without the jobs");

  await untilBatchStatus(client, batch.id, "paused");
  expect(await client.batches.get({ id: batch.id })).toMatchObject({
    pausedBy: "breaker",
    jobCounts: { failed: 1, queued: 2 },
  });
  const held = await client.jobs.list({ batchId: batch.id, status: ["queued"] });
  expect(held.jobs.map((listed) => listed.blockedBy)).toEqual([
    "batchPausedByBreaker",
    "batchPausedByBreaker",
  ]);

  system.model.setResponses([untilAborted]);
  expect(await client.batches.resume({ id: batch.id })).toMatchObject({ status: "active" });
  await untilStatus(client, second, "running");
  expect(await client.jobs.get({ id: third })).toMatchObject({ blockedBy: "batchCanary" });
  const late = await client.batches.addJobs({ id: batch.id, jobs: [jobNamed("4")] });
  expect(late.jobs[0]?.job.blockedBy).toBe("batchCanary");

  await client.batches.cancel({ id: batch.id });
  await untilBatchStatus(client, batch.id, "cancelled");
});

// With four jobs, the new Canary flags the third and fourth; with two, it finds none to flag, and its
// places wait for jobs added later.
test.each([4, 2])(
  "a job sent before a new Canary began, ending during it, does not judge the Batch in the Canary's place (%i jobs)",
  async (total) => {
    const client = await system.clientWithNewJobsKey();
    const batch = await client.batches.create({
      agent: AGENT,
      breaker: { canary: 2, maxFailurePercent: 10 },
    });
    const { promise: failing, resolve: fail } = Promise.withResolvers<void>();
    // One of the first Canary's jobs fails at once; the other, later.
    system.model.setResponses([
      reply("I cannot."),
      async () => {
        await failing;
        return reply("I cannot either.");
      },
    ]);
    const { jobs } = await client.batches.addJobs({
      id: batch.id,
      jobs: Array.from({ length: total }, (_, i) => jobNamed(String(i + 1))),
    });
    const nextCanary = jobs.slice(2).map(({ job }) => job.id);
    await untilBatchStatus(client, batch.id, "paused");

    system.model.setResponses([untilAborted, untilAborted]);
    await client.batches.resume({ id: batch.id });
    for (const id of nextCanary) await untilStatus(client, id, "running");
    fail();
    await expect
      .poll(async () => (await client.batches.get({ id: batch.id })).jobCounts.failed, {
        timeout: 15_000,
      })
      .toBe(2);
    expect(await client.batches.get({ id: batch.id })).toMatchObject({ status: "active" });
    await client.batches.cancel({ id: batch.id });
    await untilBatchStatus(client, batch.id, "cancelled");
  },
);

test("outside a Canary, the breaker pauses the Batch when more than maxFailurePercent of its jobs ended since have failed, each job counted once", async () => {
  const client = await system.clientWithNewJobsKey();
  const batch = await client.batches.create({
    agent: AGENT,
    breaker: { canary: 0, maxFailurePercent: 50 },
  });
  /** Adds the job `customId`, whose agent makes `responses`, and waits for it to end `status`. */
  async function run(
    customId: string,
    responses: Parameters<typeof system.model.setResponses>[0],
    status: string,
  ) {
    system.model.setResponses(responses);
    const [added] = (await client.batches.addJobs({ id: batch.id, jobs: [jobNamed(customId)] }))
      .jobs;
    if (!added) throw new Error("The add answered without the job");
    await untilStatus(client, added.job.id, status);
    return added.job.id;
  }

  await run("1", [callTool("submit_output", { value: 1 })], "succeeded");
  // One of two failed: not more than half.
  const failed = await run("2", [reply("I cannot.")], "failed");
  // Its resume withdraws its failure, so failing again leaves one of two.
  system.model.setResponses([reply("I still cannot.")]);
  await client.jobs.resume({ id: failed });
  await untilStatus(client, failed, "failed");
  expect(await client.batches.get({ id: batch.id })).toMatchObject({ status: "active" });

  // Two of three.
  await run("3", [reply("I cannot either.")], "failed");
  await untilBatchStatus(client, batch.id, "paused");
  expect(await client.batches.get({ id: batch.id })).toMatchObject({ pausedBy: "breaker" });
  await client.batches.cancel({ id: batch.id });
}, 20_000);

test("a caller's pause keeps the breaker counting, and the caller's resume after it tripped runs a new Canary first", async () => {
  const client = await system.clientWithNewJobsKey();
  const batch = await client.batches.create({
    agent: AGENT,
    breaker: { canary: 1, maxFailurePercent: 100 },
  });
  const { promise: failing, resolve: fail } = Promise.withResolvers<void>();
  system.model.setResponses([
    async () => {
      await failing;
      return reply("I cannot.");
    },
  ]);
  const [first] = (await client.batches.addJobs({ id: batch.id, jobs: [jobNamed("1")] })).jobs;
  if (!first) throw new Error("The add answered without the job");
  await untilStatus(client, first.job.id, "running");

  await client.batches.pause({ id: batch.id });
  fail();
  await untilStatus(client, first.job.id, "failed");
  expect(await client.batches.get({ id: batch.id })).toMatchObject({
    status: "paused",
    pausedBy: "caller",
  });
  const { jobs } = await client.batches.addJobs({
    id: batch.id,
    jobs: [jobNamed("2"), jobNamed("3")],
  });
  const [second, third] = jobs.map(({ job }) => job.id);
  if (!second || !third) throw new Error("The add answered without the jobs");

  system.model.setResponses([untilAborted]);
  await client.batches.resume({ id: batch.id });
  await untilStatus(client, second, "running");
  expect(await client.jobs.get({ id: third })).toMatchObject({ blockedBy: "batchCanary" });

  await client.batches.cancel({ id: batch.id });
  await untilBatchStatus(client, batch.id, "cancelled");
});

test("a Batch without a breaker releases every job at once and never pauses itself", async () => {
  // Every job's model call fails.
  system.model.setResponses([]);
  const client = await system.clientWithNewJobsKey();
  const batch = await client.batches.create({ agent: AGENT, breaker: false });
  const added = await client.batches.addJobs({
    id: batch.id,
    jobs: ["1", "2", "3"].map((customId) => jobNamed(customId)),
  });
  expect(blockedBy(added)).toEqual(["none", "none", "none"]);

  await expect
    .poll(async () => (await client.batches.get({ id: batch.id })).jobCounts.failed, {
      timeout: 15_000,
    })
    .toBe(3);
  expect(await client.batches.get({ id: batch.id })).toMatchObject({ status: "active" });
});

test("a Batch's summary counts its jobs by status and adds up their cost, those deleted left out", async () => {
  system.model.setResponses([
    callTool("submit_output", { value: 1 }),
    callTool("submit_output", { value: 2 }),
  ]);
  const client = await system.clientWithNewJobsKey();
  const batch = await client.batches.create({ agent: AGENT, breaker: false });
  const { jobs } = await client.batches.addJobs({
    id: batch.id,
    jobs: [jobNamed("1"), jobNamed("2")],
  });
  await expect
    .poll(async () => (await client.batches.get({ id: batch.id })).jobCounts.succeeded, {
      timeout: 15_000,
    })
    .toBe(2);
  const listed = await client.jobs.list({ batchId: batch.id });
  const costs = new Map(listed.jobs.map((each) => [each.id, each.usage.cost.totalUsd]));
  const ended = await client.batches.get({ id: batch.id });
  expect(ended.usage.cost.totalUsd).toBeCloseTo(
    [...costs.values()].reduce((sum, cost) => sum + cost, 0),
    10,
  );
  expect(ended.usage.cost.totalUsd).toBeGreaterThan(0);

  const [deleted, kept] = jobs.map(({ job }) => job.id);
  if (!deleted || !kept) throw new Error("The add answered without the jobs");
  await client.jobs.delete({ id: deleted });
  const afterDelete = await client.batches.get({ id: batch.id });
  expect(afterDelete.jobCounts).toMatchObject({ succeeded: 1 });
  expect(afterDelete.usage.cost.totalUsd).toBeCloseTo(costs.get(kept) ?? Number.NaN, 10);
});

test("cancelling a Batch waits for the Runners of its running jobs, shown as its pendingControl, and then resumes none of them", async () => {
  system.model.setResponses([untilAborted]);
  const client = await system.clientWithNewJobsKey();
  const batch = await client.batches.create({ agent: AGENT, breaker: false });
  const [added] = (await client.batches.addJobs({ id: batch.id, jobs: [jobNamed("1")] })).jobs;
  if (!added) throw new Error("The add answered without the job");
  await untilStatus(client, added.job.id, "running");

  expect(await client.batches.cancel({ id: batch.id })).toMatchObject({
    status: "active",
    pendingControl: { type: "cancel", requestedAt: expect.any(Date) },
  });
  await untilBatchStatus(client, batch.id, "cancelled");
  expect(await client.batches.get({ id: batch.id })).not.toHaveProperty("pendingControl");
  await expect(client.jobs.resume({ id: added.job.id })).rejects.toMatchObject({
    code: "CONFLICT",
  });
});
