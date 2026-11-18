import { betterAuth } from "better-auth";
import { problemOf, type Usage, type UsageReport } from "contract";
import { Struct } from "effect";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, inject, test } from "vite-plus/test";

import { offlineAuthOptions } from "../src/auth/options.ts";
import { DB_SCHEMA, openDatabase } from "../src/db/database.ts";
import { type ApiClient, startSystem, submitJob, untilStatus } from "./harness.ts";
import { callTool } from "./scripted-model.ts";

// Reading the Organization's usage, against a real hub and Runner: what jobs used, added up from
// their Usage records by day and by group.

const system = startSystem();

beforeAll(() => system.start());
afterAll(() => system.stop());

const AGENT = { outputContract: { schema: { type: "integer" } } };
const JOB_PERMISSIONS = { job: ["create", "read", "pause", "resume", "cancel", "delete"] };

/** A new API key named `name` that may submit and control jobs, and a client sending it. */
async function newKey(name: string) {
  const { id, key } = await system.owner().apiKeys.create({ name, permissions: JOB_PERMISSIONS });
  return { id, client: system.client({ "x-api-key": key }) };
}

/** `usages` added up. */
function sumOf(usages: Usage[]) {
  return {
    totalTokens: usages.reduce((sum, usage) => sum + usage.totalTokens, 0),
    totalUsd: usages.reduce((sum, usage) => sum + usage.cost.totalUsd, 0),
  };
}

/** Expects `usages` to add up to `total`. */
function expectSum(usages: Usage[], total: Usage) {
  const sum = sumOf(usages);
  expect(sum.totalTokens).toBe(total.totalTokens);
  expect(sum.totalUsd).toBeCloseTo(total.cost.totalUsd, 10);
}

/**
 * Expects `report`'s days to add up to its total and, when grouped, its groups and `other` too,
 * each day to hold the same groups with its own share, and each group's days to add up to the group.
 */
function expectAddsUp(report: UsageReport) {
  expectSum(
    report.days.map((day) => day.usage),
    report.usage,
  );
  const { groups, other } = report;
  if (groups === undefined || other === undefined) return;
  expectSum([...groups.map((group) => group.usage), other.usage], report.usage);
  const identity = (group: (typeof groups)[number]) => Struct.omit(group, ["usage"]);
  for (const day of report.days) {
    expect(day.groups?.map(identity)).toEqual(groups.map(identity));
    expectSum(
      [...(day.groups ?? []).map((group) => group.usage), day.other?.usage ?? zero],
      day.usage,
    );
  }
  groups.forEach((group, index) => {
    expectSum(
      report.days.flatMap((day) => day.groups?.[index]?.usage ?? []),
      group.usage,
    );
  });
}

const zero: Usage = { totalTokens: 0, cost: { totalUsd: 0 } };

/** Expects `usage` to be `expected`, money to within rounding. */
function expectUsage(usage: Usage, expected: Usage) {
  expect(usage.totalTokens).toBe(expected.totalTokens);
  expect(usage.cost.totalUsd).toBeCloseTo(expected.cost.totalUsd, 10);
}

/** Signs in as a new member of the Organization with the plain `member` role. */
async function signInAsMember(): Promise<ApiClient> {
  // Public sign-up is off, so the account is created as setup creates the owner's.
  await using db = openDatabase(inject("databaseUrl"));
  const options = offlineAuthOptions(db);
  const auth = betterAuth({
    ...options,
    emailAndPassword: { ...options.emailAndPassword, disableSignUp: false, autoSignIn: false },
  });
  const member = { email: "member@example.com", password: "a long enough password" };
  const { user } = await auth.api.signUpEmail({ body: { ...member, name: "Member" } });
  const organization = await db
    .withSchema(DB_SCHEMA)
    .selectFrom("organization")
    .select("id")
    .executeTakeFirstOrThrow();
  await auth.api.addMember({
    body: { userId: user.id, organizationId: organization.id, role: "member" },
  });
  return system.client({ cookie: await system.signIn(member), origin: system.origin });
}

test("usage adds up by day and by group, counting each end of a resumed job once and deleted jobs", async () => {
  const billing = await newKey("billing");
  const support = await newKey("support");
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
  await billing.client.jobs.cancel({ id: unstarted?.job.id ?? "" });
  const runnerId = await system.startRunner();

  // Cancelled while it runs a command, then resumed to succeed: two ends.
  system.model.setResponses([callTool("bash", { command: "sleep 600" })]);
  const [resumed] = (
    await billing.client.batches.addJobs({
      id: batch.id,
      jobs: [{ customId: "resumed", input: "Wait." }],
    })
  ).jobs;
  const resumedId = resumed?.job.id ?? "";
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
  expectUsage(byStatus.usage, resumedUsage);
  expectUsage(
    (await owner.usage.get({ batchId: batch.id, status: ["cancelled"] })).usage,
    firstEnd,
  );

  // A deleted job's use stays, under the key that submitted it, whose name stays once revoked.
  await owner.apiKeys.revoke({ id: support.id });
  expectUsage((await owner.usage.get({ keyId: support.id })).usage, deletedUsage);
  const byKey = await owner.usage.get({ groupBy: "key" });
  expectAddsUp(byKey);
  expect(byKey.groups).toEqual(
    expect.arrayContaining([
      { key: { id: billing.id, name: "billing" }, usage: expect.anything() },
      { key: { id: support.id, name: "support" }, usage: expect.anything() },
    ]),
  );

  const byLabel = await owner.usage.get({ groupBy: "label:customer" });
  expectAddsUp(byLabel);
  expect(byLabel.groups).toHaveLength(3);
  expect(byLabel.groups).toEqual(
    expect.arrayContaining([
      { labelValue: "acme", usage: expect.anything() },
      { labelValue: null, usage: deletedUsage },
      { labelValue: "globex", usage: zero },
    ]),
  );
  expectUsage((await owner.usage.get({ labels: { customer: "acme" } })).usage, resumedUsage);

  const byRunner = await owner.usage.get({ groupBy: "runner", runnerId });
  expectAddsUp(byRunner);
  expect(byRunner.groups).toEqual([
    { runner: { id: runnerId, name: expect.any(String) }, usage: report.usage },
  ]);
  expect((await owner.usage.get({ groupBy: "runner" })).groups?.at(-1)).toEqual({
    runner: null,
    usage: zero,
  });

  const topBatch = await owner.usage.get({ groupBy: "batch", limit: 1 });
  expectAddsUp(topBatch);
  expect(topBatch.groups).toHaveLength(1);
  expect(topBatch.other?.groups).toBe(1);

  // A day holds what the hub recorded that day.
  await using db = openDatabase(inject("databaseUrl"));
  const { rows } = await sql<{ recordedAt: Date }>`
    update ${sql.table(`${DB_SCHEMA}.usageRecord`)}
    set "recordedAt" = "recordedAt" - interval '3 days'
    where "jobId" = ${deleted.id}
    returning "recordedAt"
  `.execute(db);
  const day = rows[0]?.recordedAt.toISOString().slice(0, 10);
  const moved = await owner.usage.get({ keyId: support.id });
  expect(moved.days.filter((each) => each.usage.totalTokens > 0)).toEqual([
    { date: day, usage: deletedUsage },
  ]);
  expect((await owner.usage.get({ keyId: support.id, from: report.to })).usage).toEqual(zero);
}, 30_000);

test("a window that ends before it starts, or is longer than 400 days, is refused naming `from`", async () => {
  const owner = system.owner();
  for (const window of [
    { from: "2026-11-10", to: "2026-11-01" },
    { from: "2025-09-26", to: "2026-10-31" },
  ]) {
    const problem = problemOf(await owner.usage.get(window).catch((error: unknown) => error));
    expect(problem).toMatchObject({ status: 400, detail: expect.stringContaining("from") });
  }
  // 400 days, both included.
  expect((await owner.usage.get({ from: "2025-09-27", to: "2026-10-31" })).days).toHaveLength(400);
});

test("a member whose role does not allow reading usage is refused", async () => {
  const member = await signInAsMember();
  await expect(member.usage.get({})).rejects.toMatchObject({ code: "FORBIDDEN", defined: true });
});
