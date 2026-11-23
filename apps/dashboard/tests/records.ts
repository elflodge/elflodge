import type { InferContractRouterOutputs } from "@orpc/contract";
import {
  JOB_FAILED,
  JOB_STARTED,
  JOB_SUCCEEDED,
  type ApiKey,
  type apiContract,
  type Batch,
  type Job,
  type JobCounts,
  type JobEvent,
  type ListedJob,
  type OpenFailure,
  type rankedUsageSchema,
  type Runner,
  type UsageReport,
} from "contract";
import { v5 as uuidv5 } from "uuid";
import type * as z from "zod/mini";

import { OrganizationId, UserId } from "../../hub/src/db/types.ts";
import type { Member } from "../src/organization.ts";
import type { Session } from "./hub.ts";

// Records as the hub's answers carry them, complete, for tests to arrange. Each takes the fields a
// test is about and fills in the rest.

/** The instant the page clock stands at when a test starts. */
export const NOW = new Date("2026-11-23T12:00:00Z");

/** The instant `milliseconds` before `NOW`. */
export const ago = (milliseconds: number) => new Date(NOW.getTime() - milliseconds);
const DAY = 86_400_000;

// IDs derived from the names, so a record keeps its ID however a test builds it.
const NAMESPACE = "0b5b2d8e-6c2e-4f7a-9a4d-5f1e8c3b7a61";
const idFor = (kind: string, name: string) => uuidv5(`${kind}:${name}`, NAMESPACE);

export type Role = "owner" | "admin" | "member";

/** The session of a member of the Organization with `role`. */
export function signedIn(role: Role = "owner"): NonNullable<Session> {
  const userId = UserId(idFor("user", role));
  const organizationId = OrganizationId(idFor("organization", "Lodge"));
  const at = ago(30 * DAY);
  return {
    user: {
      id: userId,
      name: `Robin ${role[0]?.toUpperCase()}${role.slice(1)}`,
      email: `${role}@example.com`,
      emailVerified: true,
      image: undefined,
      createdAt: at,
      updatedAt: at,
    },
    session: {
      id: idFor("session", role),
      userId,
      token: "session-token",
      expiresAt: new Date(NOW.getTime() + 7 * DAY),
      createdAt: at,
      updatedAt: at,
      activeOrganizationId: organizationId,
    },
    membership: { status: "member", organization: { id: organizationId, name: "Lodge" }, role },
  };
}

/** `session` with its member's role in the Organization changed to `role`. */
export function withRole(session: NonNullable<Session>, role: Role): NonNullable<Session> {
  if (session.membership.status !== "member") throw new Error("The session has no membership");
  return { ...session, membership: { ...session.membership, role } };
}

/** `session` once its member is no longer a member of the Organization, as after leaving it. */
export function withoutMembership(session: NonNullable<Session>): NonNullable<Session> {
  return { ...session, membership: { status: "notMember" } };
}

/** A member of the Organization named `name`, with `role`, who joined 90 days ago. */
export function aMember(name: string, role: Member["role"] = "member"): Member {
  const userId = idFor("user", name);
  return {
    id: idFor("member", name),
    organizationId: idFor("organization", "Lodge"),
    userId,
    role,
    createdAt: ago(90 * DAY),
    user: {
      id: userId,
      name,
      email: `${name.toLowerCase().replaceAll(" ", ".")}@example.com`,
      image: undefined,
    },
  };
}

/** The member signed in by `session`, as the members list shows them. */
export function memberOf(session: NonNullable<Session>): Member {
  if (session.membership.status !== "member") throw new Error("The session has no membership");
  const { user } = session;
  return {
    ...aMember(user.name, session.membership.role),
    userId: user.id,
    user: { id: user.id, name: user.name, email: user.email, image: undefined },
  };
}

/** The members list Better Auth answers with `members`. */
export function roster(...members: Member[]) {
  return { members, total: members.length };
}

type Invitation = InferContractRouterOutputs<typeof apiContract>["invitations"]["list"][number];

/** A pending invitation for `email`, to join as a member, made by the signed-in owner a day ago. */
export function anInvitation(email: string, fields: Partial<Invitation> = {}): Invitation {
  const owner = signedIn("owner").user;
  return {
    id: idFor("invitation", email),
    email,
    role: "member",
    inviter: { id: owner.id, name: owner.name },
    createdAt: ago(DAY),
    expiresAt: new Date(NOW.getTime() + DAY),
    ...fields,
  };
}

/** No unfinished jobs, as the strip counts them. */
export const NO_JOBS: JobCounts = {
  jobCounts: { queued: 0, running: 0, paused: 0 },
  statusUnknownJobCounts: { queued: 0, running: 0 },
};

/** A Runner named `name`, connected and with nothing reported. */
export function aRunner(name: string, fields: Partial<Runner> = {}): Runner {
  return {
    id: idFor("runner", name),
    name,
    connected: true,
    registeredAt: ago(7 * DAY),
    lastSeenAt: ago(20_000),
    capabilities: null,
    ...fields,
  };
}

/** A key named `name` that may read jobs, created by the signed-in owner, never expiring. */
export function anApiKey(name: string, fields: Partial<ApiKey> = {}): ApiKey {
  const id = idFor("api key", name);
  const owner = signedIn("owner").user;
  return {
    id,
    name,
    start: id.slice(0, 6),
    permissions: { job: ["read"] },
    creator: { id: owner.id, name: owner.name, isMember: true },
    createdAt: ago(DAY),
    expiresAt: null,
    ...fields,
  };
}

/** What every job reports, whatever its status, as a list reports it. */
type JobBase = Omit<Exclude<ListedJob, { status: "failed" }>, "status">;

/** Fields of a job, and, unless it is queued, its status with what that status carries. */
type JobFields<Record extends { status: string }> =
  | Partial<JobBase>
  | (Partial<JobBase> & (Record extends unknown ? Omit<Record, keyof JobBase> : never));

function jobBase(customId: string): JobBase {
  const owner = signedIn("owner").user;
  return {
    id: idFor("job", customId),
    createdAt: ago(60 * 60_000),
    startedAt: null,
    endedAt: null,
    usage: { totalTokens: 0, cost: { totalUsd: 0 } },
    toolCalls: {},
    runTimeoutSeconds: 3600,
    modelBudgetUsd: 1,
    batchId: "april",
    customId,
    submitter: { kind: "member", id: owner.id, name: owner.name },
    labels: {},
    lastReportedAt: null,
  };
}

/**
 * The job with the Custom ID `customId`, in the Batch `april`, submitted by the owner, as the job
 * page reads it: queued and not yet sent to a Runner unless `fields` say otherwise.
 */
export function aJob(customId: string, fields: JobFields<Job> = {}): Job {
  return { ...jobBase(customId), status: "queued", ...fields };
}

/** The job `aJob` makes for `customId`, as the jobs list shows it. */
export function aListedJob(customId: string, fields: JobFields<ListedJob> = {}): ListedJob {
  return { ...jobBase(customId), status: "queued", ...fields };
}

/** `runner` as a job sent to it names it. */
export function sentTo(runner: Runner): NonNullable<Job["runner"]> {
  return {
    id: runner.id,
    name: runner.name,
    lastSeenAt: runner.lastSeenAt,
    connected: runner.connected,
  };
}

/** A failure for `reason`, as a job reports it. */
export function failedFor(
  reason: OpenFailure["reason"],
  message?: string,
): Extract<Job, { status: "failed" }>["failure"] {
  return message === undefined ? { reason } : { reason, message };
}

/** The Batch `id`, active, created by the owner, without a failure breaker and with no jobs. */
export function aBatch(id: string, fields: Partial<Batch> = {}): Batch {
  const owner = signedIn("owner").user;
  const none = { queued: 0, running: 0, paused: 0, succeeded: 0, failed: 0, cancelled: 0 };
  return {
    id,
    createdAt: ago(DAY),
    status: "active",
    submitter: { kind: "member", id: owner.id, name: owner.name },
    pausedBy: null,
    labels: {},
    breaker: false,
    jobCounts: none,
    jobsWaitingForCanary: 0,
    statusUnknownJobs: 0,
    usage: { totalTokens: 0, cost: { totalUsd: 0 } },
    toolCalls: {},
    ...fields,
  };
}

// A job's Events as its journal records them: its conversation, the Runner's entries about the job,
// and pi's entries, each at the page clock's `NOW`.

/** The record of the job's first conversation. */
export const aConversation = (id: number): JobEvent => ({
  id,
  type: "conversation",
  record: { id },
});

/** The Runner's entry for the job's start, in its first conversation. */
export function aStart(id: number): JobEvent {
  const data = { timestamp: NOW.getTime(), runId: idFor("run", "first"), runnerVersion: "0.0.0" };
  return { id, type: "entry", record: { id, conversationId: 1, kind: JOB_STARTED, data } };
}

/** pi's entry for a user message, `Invoice <id>.`, in the first conversation. */
export function aMessage(id: number): JobEvent {
  const model = [{ role: "user", content: `Invoice ${id}.`, timestamp: NOW.getTime() }];
  return { id, type: "entry", record: { id, conversationId: 1, kind: "pi.user", model } };
}

/** pi's entry for a call of `bash` that ran and printed `lines` lines. */
export function aToolResult(id: number, lines: number): JobEvent {
  const text = Array.from({ length: lines }, (_, line) => `Invoice ${line + 1}\n`).join("");
  const model = [
    {
      role: "toolResult",
      toolCallId: `call-${id}`,
      toolName: "bash",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: NOW.getTime(),
    },
  ];
  return { id, type: "entry", record: { id, conversationId: 1, kind: "pi.tool-result", model } };
}

/** The Runner's entry for the job's success with `output`. */
export function aSuccess(id: number, output: unknown): JobEvent {
  const data = { timestamp: NOW.getTime(), output };
  return { id, type: "entry", record: { id, conversationId: 1, kind: JOB_SUCCEEDED, data } };
}

/** The Runner's entry for the job's failure, as `failure` says. */
export function aFailure(id: number, failure: OpenFailure): JobEvent {
  const data = { timestamp: NOW.getTime(), ...failure };
  return { id, type: "entry", record: { id, conversationId: 1, kind: JOB_FAILED, data } };
}

/** A Batch's jobs counted by status: `counts`, and none of every other status. */
export function jobsCounted(counts: Partial<Batch["jobCounts"]>): Batch["jobCounts"] {
  return { queued: 0, running: 0, paused: 0, succeeded: 0, failed: 0, cancelled: 0, ...counts };
}

/** The hub's limits for a job: its defaults, and the most it accepts. */
export const JOB_LIMITS = {
  runTimeoutSeconds: { default: 3_600, max: 86_400 },
  modelBudgetUsd: { default: 1, max: 5 },
};

/** Job ends and what they used, as a usage report counts them for a day, a group or its window. */
export function usageCount(jobEnds: number, totalTokens = 0, totalUsd = 0) {
  return { jobEnds, usage: { totalTokens, cost: { totalUsd } } };
}

/** NOW's UTC day, which the hub records today's job ends under. */
export const TODAY = NOW.toISOString().slice(0, 10);

/**
 * The hub's report of the UTC days `from` to `to`, today by default, read at NOW: each day's
 * figures from `days`, by date, none on the others, and their sum for the window; ranked by the
 * groups of `ranked` when it gives them, with no others.
 */
export function aUsageReport(
  window: { from: string; to?: string; days?: Record<string, ReturnType<typeof usageCount>> },
  ranked?: z.input<typeof rankedUsageSchema>,
): UsageReport {
  const { from, to = TODAY, days = {} } = window;
  const dates: string[] = [];
  for (let day = new Date(from); day <= new Date(to); day.setUTCDate(day.getUTCDate() + 1))
    dates.push(day.toISOString().slice(0, 10));
  const counted = dates.map((date) => ({ date, ...(days[date] ?? usageCount(0)) }));
  const sum = (pick: (figures: ReturnType<typeof usageCount>) => number) =>
    counted.reduce((total, day) => total + pick(day), 0);
  const total = usageCount(
    sum(({ jobEnds }) => jobEnds),
    sum(({ usage }) => usage.totalTokens),
    sum(({ usage }) => usage.cost.totalUsd),
  );
  const report = { from, to, today: TODAY, readAt: NOW, days: counted, ...total };
  return ranked ? { ...report, ...ranked, other: { groups: 0, ...usageCount(0) } } : report;
}
