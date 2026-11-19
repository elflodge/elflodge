import type { Usage, UsageReport } from "contract";
import { Duration } from "effect";
import { afterAll, assert, beforeAll, expect, inject, test } from "vite-plus/test";

import { DB_SCHEMA, openDatabase, plusDuration } from "../src/db/database.ts";
import { JobId } from "../src/db/types.ts";
import { startSystem, submitJob, untilStatus } from "./harness.ts";
import { callTool } from "./scripted-model.ts";

// Reading the Organization's usage, against a real hub and Runner: what jobs used, added up from
// their Usage records by day and by group.

const system = startSystem();

beforeAll(() => system.start());
afterAll(() => system.stop());

const AGENT = { outputContract: { schema: { type: "integer" } } };

/** The days add up to the window total, as do the ranked groups together with `other`. */
function expectAddsUp(report: UsageReport) {
  function expectTotal(rows: Pick<UsageReport, "jobEnds" | "usage">[]) {
    expect(rows.reduce((sum, row) => sum + row.jobEnds, 0)).toBe(report.jobEnds);
    expectUsage(
      {
        totalTokens: rows.reduce((sum, row) => sum + row.usage.totalTokens, 0),
        cost: { totalUsd: rows.reduce((sum, row) => sum + row.usage.cost.totalUsd, 0) },
      },
      report.usage,
    );
  }
  expectTotal(report.days);
  if (report.groups !== undefined) expectTotal([...report.groups, report.other]);
}

const zero: Usage = { totalTokens: 0, cost: { totalUsd: 0 } };

/** Expects `usage` to be `expected`, money to within rounding. */
function expectUsage(usage: Usage, expected: Usage) {
  expect(usage.totalTokens).toBe(expected.totalTokens);
  expect(usage.cost.totalUsd).toBeCloseTo(expected.cost.totalUsd, 10);
}

test("usage adds up by day and by group, counting each end of a resumed job once and deleted jobs", async () => {
  const billing = await system.createApiKey({ name: "billing" });
  const support = await system.createApiKey({ name: "support" });
  const batch = await billing.client.batches.create({
    agent: AGENT,
    labels: { customer: "acme" },
    breaker: false,
  });
  // Cancelled before any Runner started it: an end without usage or a Runner.
  const [unstarted] = (
    await billing.client.batches.addJobs({
      id: batch.id,
      jobs: [{ customId: "unstarted", input: "Never mind.", labels: { customer: "globex" } }],
    })
  ).jobs;
  assert(unstarted, "The add answered without the job");
  await billing.client.jobs.cancel({ id: unstarted.job.id });
  const runnerId = await system.startRunner();

  // Cancelled while it runs a command, then resumed to succeed: two ends.
  system.model.setResponses([callTool("bash", { command: "sleep 600" })]);
  const [resumed] = (
    await billing.client.batches.addJobs({
      id: batch.id,
      jobs: [{ customId: "resumed", input: "Wait." }],
    })
  ).jobs;
  assert(resumed, "The add answered without the job");
  const resumedId = resumed.job.id;
  await expect
    .poll(async () => (await billing.client.jobs.get({ id: resumedId })).activity?.[0]?.tools, {
      timeout: 10_000,
    })
    .toMatchObject([{ name: "bash", status: "running" }]);
  await billing.client.jobs.cancel({ id: resumedId });
  await untilStatus(billing.client, resumedId, "cancelled");
  const firstEnd = (await billing.client.jobs.get({ id: resumedId })).usage;
  system.model.setResponses([callTool("submit_output", { value: 1 })]);
  await billing.client.jobs.resume({ id: resumedId });
  await untilStatus(billing.client, resumedId, "succeeded");

  // Run to the end by another key, then deleted.
  system.model.setResponses([callTool("submit_output", { value: 2 })]);
  const deleted = await submitJob(support.client, { ...AGENT, input: "Two." });
  await untilStatus(support.client, deleted.id, "succeeded");
  const deletedUsage = (await support.client.jobs.get({ id: deleted.id })).usage;
  await support.client.jobs.delete({ id: deleted.id });

  const resumedUsage = (await billing.client.jobs.get({ id: resumedId })).usage;
  expect(firstEnd.cost.totalUsd).toBeGreaterThan(0);
  expect(resumedUsage.cost.totalUsd).toBeGreaterThan(firstEnd.cost.totalUsd);
  const owner = system.owner();

  const report = await owner.usage.get({});
  expect(report).not.toHaveProperty("groups");
  expect(report).not.toHaveProperty("other");
  expect(report.jobEnds).toBe(4);
  expect(report.days).toHaveLength(30);
  expect([report.days[0]?.date, report.days.at(-1)?.date]).toEqual([report.from, report.to]);
  expectUsage(report.usage, {
    totalTokens: resumedUsage.totalTokens + deletedUsage.totalTokens,
    cost: { totalUsd: resumedUsage.cost.totalUsd + deletedUsage.cost.totalUsd },
  });
  expectAddsUp(report);

  // Each end counts what the job used since the previous one.
  const byStatus = await owner.usage.get({ groupBy: "status", batchId: batch.id });
  expectAddsUp(byStatus);
  expect(byStatus.groups?.map((group) => "status" in group && group.status).toSorted()).toEqual([
    "cancelled",
    "succeeded",
  ]);
  expect(byStatus.other).toEqual({ groups: 0, jobEnds: 0, usage: zero });
  expectUsage(byStatus.usage, resumedUsage);
  expectUsage(
    (await owner.usage.get({ batchId: batch.id, status: ["cancelled"] })).usage,
    firstEnd,
  );

  // A deleted job's use stays, under the key that submitted it, whose name stays once revoked.
  await owner.apiKeys.revoke({ id: support.id });
  expectUsage(
    (await owner.usage.get({ submitter: { kind: "key", id: support.id } })).usage,
    deletedUsage,
  );
  const bySubmitter = await owner.usage.get({ groupBy: "submitter" });
  expectAddsUp(bySubmitter);
  expect(bySubmitter.groups).toEqual(
    expect.arrayContaining([
      {
        submitter: { kind: "key", id: billing.id, name: "billing" },
        jobEnds: 3,
        usage: resumedUsage,
      },
      {
        submitter: { kind: "key", id: support.id, name: "support" },
        jobEnds: 1,
        usage: deletedUsage,
      },
    ]),
  );

  const byLabel = await owner.usage.get({ groupBy: "label:customer" });
  expectAddsUp(byLabel);
  expect(byLabel.groups).toHaveLength(3);
  expect(byLabel.groups).toEqual(
    expect.arrayContaining([
      { labelValue: "acme", jobEnds: 2, usage: resumedUsage },
      { labelValue: null, jobEnds: 1, usage: deletedUsage },
      { labelValue: "globex", jobEnds: 1, usage: zero },
    ]),
  );
  expectUsage((await owner.usage.get({ labels: { customer: "acme" } })).usage, resumedUsage);

  const byRunner = await owner.usage.get({ groupBy: "runner", runnerId });
  expectAddsUp(byRunner);
  expect(byRunner.groups).toEqual([
    { runner: { id: runnerId, name: expect.any(String) }, jobEnds: 3, usage: report.usage },
  ]);
  expect((await owner.usage.get({ groupBy: "runner" })).groups?.at(-1)).toEqual({
    runner: null,
    jobEnds: 1,
    usage: zero,
  });

  // A day holds what the hub recorded that day: the deleted job's end, moved three days back.
  await using db = openDatabase(inject("databaseUrl"));
  const { recordedAt } = await db
    .withSchema(DB_SCHEMA)
    .updateTable("usageRecord")
    .set((eb) => ({ recordedAt: plusDuration(eb.ref("recordedAt"), Duration.days(-3)) }))
    .where("jobId", "=", JobId(deleted.id))
    .returning("recordedAt")
    .executeTakeFirstOrThrow();
  const day = recordedAt.toISOString().slice(0, 10);
  const moved = await owner.usage.get({ submitter: { kind: "key", id: support.id } });
  expect(moved.days.filter((each) => each.usage.totalTokens > 0)).toEqual([
    { date: day, jobEnds: 1, usage: deletedUsage },
  ]);
  expect(
    (await owner.usage.get({ submitter: { kind: "key", id: support.id }, from: report.to })).usage,
  ).toEqual(zero);

  // The top Batch is ranked over the window. The deleted job still counts on its own day.
  expect(resumedUsage.cost.totalUsd).toBeGreaterThan(deletedUsage.cost.totalUsd);
  const topBatch = await owner.usage.get({ groupBy: "batch", limit: 1 });
  expectAddsUp(topBatch);
  expect(topBatch.groups).toEqual([{ batchId: batch.id, jobEnds: 3, usage: resumedUsage }]);
  expect(topBatch.other).toEqual({ groups: 1, jobEnds: 1, usage: deletedUsage });
  expect(topBatch.days.find((each) => each.date === day)).toEqual({
    date: day,
    jobEnds: 1,
    usage: deletedUsage,
  });
}, 30_000);

test("usage by submitter tells a member's jobs from a key's", async () => {
  const labels = { suite: "submitters" };
  const key = await system.createApiKey({ name: "intake" });
  const { client: member, userId } = await system.addMember({
    email: "intake@example.com",
    name: "Ira Intake",
  });
  // Each cancels a job no Runner was sent, held by its paused Batch: an end with a Usage record.
  for (const client of [key.client, member]) {
    const batch = await client.batches.create({ agent: AGENT, labels, breaker: false });
    await client.batches.pause({ id: batch.id });
    const {
      jobs: [added],
    } = await client.batches.addJobs({
      id: batch.id,
      jobs: [{ customId: "intake", input: "Never mind." }],
    });
    assert(added, "The add answered without the job");
    await client.jobs.cancel({ id: added.job.id });
  }

  const bySubmitter = await system.owner().usage.get({ groupBy: "submitter", labels });
  expect(bySubmitter.groups).toHaveLength(2);
  expect(bySubmitter.groups).toEqual(
    expect.arrayContaining([
      { submitter: { kind: "key", id: key.id, name: "intake" }, jobEnds: 1, usage: zero },
      { submitter: { kind: "member", id: userId, name: "Ira Intake" }, jobEnds: 1, usage: zero },
    ]),
  );

  // A filter by submitter keeps one of them, by its kind and ID, as the query string names it.
  const byMember = await system.hub.fetch(
    `/usage?groupBy=submitter&labels[suite]=submitters&submitter[kind]=member&submitter[id]=${userId}`,
    { headers: { cookie: system.ownerCookie() } },
  );
  expect(byMember.status).toBe(200);
  expect(await byMember.json()).toMatchObject({
    groups: [
      { submitter: { kind: "member", id: userId, name: "Ira Intake" }, jobEnds: 1, usage: zero },
    ],
  });
  const byKey = await system
    .owner()
    .usage.get({ groupBy: "submitter", labels, submitter: { kind: "key", id: key.id } });
  expect(byKey.groups).toEqual([
    { submitter: { kind: "key", id: key.id, name: "intake" }, jobEnds: 1, usage: zero },
  ]);
  const unknownKind = await system.hub.fetch(
    `/usage?submitter[kind]=team&submitter[id]=${key.id}`,
    {
      headers: { cookie: system.ownerCookie() },
    },
  );
  expect(unknownKind.status).toBe(400);
});

test("a window that ends before it starts, is longer than 400 days or starts before year 1 is refused naming the field given", async () => {
  const owner = system.owner();
  for (const [window, field] of [
    [{ from: "2026-11-10", to: "2026-11-01" }, "from"],
    [{ from: "2025-09-26", to: "2026-10-31" }, "from"],
    // Postgres reads no year 0000, which an ISO date may hold.
    [{ from: "0000-12-31", to: "0001-01-10" }, "from"],
    // The default `from`, 29 days before `to`, would be in year 0000.
    [{ to: "0001-01-01" }, "to"],
  ] as const) {
    await expect(owner.usage.get(window)).rejects.toMatchObject({
      cause: { status: 400, detail: expect.stringMatching(`→ at ${field}$`) },
    });
  }
  // 400 days, both included.
  expect((await owner.usage.get({ from: "2025-09-27", to: "2026-10-31" })).days).toHaveLength(400);
});

test("a member whose role does not allow reading usage is refused", async () => {
  const { client: member } = await system.addMember({
    email: "member@example.com",
    name: "Member",
  });
  await expect(member.usage.get({})).rejects.toMatchObject({
    code: "FORBIDDEN",
    defined: true,
    cause: { status: 403, detail: "This call requires read permission on usage." },
  });
});
