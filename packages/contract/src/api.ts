import { error, oc } from "@orpc/contract";
import { openapi } from "@orpc/openapi";
import * as z from "zod/mini";

import {
  batchIdSchema,
  blobRefSchema,
  customIdSchema,
  digestSchema,
  fileSizeBytesSchema,
  inputFilesSchema,
  inputSchema,
  instructionsSchema,
  jobIdSchema,
  jobRefSchema,
  labelKeySchema,
  labelsSchema,
  labelValueSchema,
  MAX_FILE_BYTES,
  MAX_LABELS,
  modelBudgetUsdSchema,
  runTimeoutSecondsSchema,
  strictBlobRefSchema,
  strictOutputContractSchema,
  textSchema,
} from "./job.ts";
import { byAnyone, byKeyOrMember, byMember, forAnyone, forMembers, NotFound } from "./procedure.ts";
import {
  failureSchema,
  jobActivitySchema,
  jobEventSchema,
  runnerCapabilitiesSchema,
} from "./runner-protocol.ts";

/** A Runner as the hub reports it. */
export const runnerSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** When the Runner registered: when the hub gave it its own key, which a restart keeps. */
    registeredAt: z.date(),
    /**
     * When the hub last heard from the Runner: its hello, or the latest sync or report the hub
     * recorded, to within ten seconds. A Runner that syncs on time is never more than about one
     * sync interval, a minute, behind.
     */
    lastSeenAt: z.date(),
    /**
     * Whether the hub has heard from the Runner within the last two minutes, as `lastSeenAt` tells:
     * recent protocol traffic, not an open socket. The jobs placed on a disconnected Runner, and not
     * yet ended or paused, show `statusUnknown`.
     */
    connected: z.boolean(),
    /**
     * What the Runner reported about itself in its latest hello: what jobs on it can do. Null when
     * it reported nothing this hub can read, as an older Runner reports nothing.
     */
    capabilities: z.nullable(runnerCapabilitiesSchema),
  })
  .register(z.globalRegistry, { id: "Runner" });
export type Runner = z.infer<typeof runnerSchema>;

/** What an API key may do, as `{ resource: actions }`, for example `{ apiKey: ["create"] }`. */
const permissionsSchema = z.record(z.string(), z.array(z.string()));

export const MAX_API_KEY_NAME_LENGTH = 32;

/** Better Auth measures passwords by JavaScript string length, in UTF-16 code units. */
export const PASSWORD_LENGTH = { min: 8, max: 128 } as const;
const passwordSchema = z.string().check(
  z.refine(
    (value) => value.length >= PASSWORD_LENGTH.min,
    `At least ${PASSWORD_LENGTH.min} characters`,
  ),
  z.refine(
    (value) => value.length <= PASSWORD_LENGTH.max,
    `At most ${PASSWORD_LENGTH.max} characters`,
  ),
  z.describe(`Between ${PASSWORD_LENGTH.min} and ${PASSWORD_LENGTH.max} UTF-16 code units.`),
);

/** An API key as the hub lists it; the key itself is shown only once, when it is created. */
export const apiKeySchema = z
  .object({
    id: z.string(),
    name: z.nullable(z.string()),
    creator: z.nullable(z.object({ id: z.string(), name: z.string(), isMember: z.boolean() })),
    /** The first characters of the key, to recognize it by. */
    start: z.nullable(z.string()),
    permissions: z.nullable(permissionsSchema),
    createdAt: z.date(),
    /** When the key stops working, if it was created to expire. */
    expiresAt: z.nullable(z.date()),
  })
  .register(z.globalRegistry, { id: "ApiKey" });
export type ApiKey = z.infer<typeof apiKeySchema>;

/** A newly created key: its ID and the key itself, shown only this once. */
const createdKeySchema = z.object({ id: z.string(), key: z.string() });

/** Where a job is in its life. A job is accepted as `queued`. */
export const jobStatusSchema = z.enum([
  "queued",
  "running",
  "paused",
  "succeeded",
  "failed",
  // Two l's, as Google's APIs (`google.rpc.Code.CANCELLED`), gRPC and GitHub spell it.
  "cancelled",
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

/** What keeps a queued job from being sent to a Runner (`Job["blockedBy"]`). */
export const blockedBySchema = z.enum([
  "batchPausedByCaller",
  "batchPausedByBreaker",
  "batchCanary",
]);

/** The statuses a job ends in: once a job reaches one, nothing more happens to it unless it is resumed. */
export const finalJobStatusSchema = z.enum(["succeeded", "failed", "cancelled"]);
export const FINAL_JOB_STATUSES: readonly JobStatus[] = finalJobStatusSchema.options;

/** Model usage as pi counts it: every model call, including those made inside tools. */
export const usageSchema = z
  .object({
    /** Tokens of every kind, summed; cached input counts each time a model call reads it. */
    totalTokens: z.int(),
    cost: z.object({
      /** pi's estimate at the models' prices, in US dollars. */
      totalUsd: z.number(),
    }),
  })
  .register(z.globalRegistry, { id: "Usage" });
export type Usage = z.infer<typeof usageSchema>;

/** Any JSON value, such as a job's output: what its Output contract's schema accepts. */
export type { JsonValue } from "type-fest";

/** The `kind` of a submitter that is an API key. */
export const KEY_SUBMITTER = "key";
/** The `kind` of a submitter that is a member, who submitted with their session. */
export const MEMBER_SUBMITTER = "member";

/** Who submitted a Batch or a job, by `kind`: an API key or a member. */
export const submitterSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal(KEY_SUBMITTER),
      /** The key's ID. */
      id: z.string(),
      /** The key's name as it was at submission, which stays once the key is revoked. */
      name: z.nullable(z.string()),
    }),
    z.object({
      kind: z.literal(MEMBER_SUBMITTER),
      /** The member's user ID, as Better Auth's organization routes give a member's `userId`. */
      id: z.string(),
      /** The member's name as it was at submission, which stays once the member leaves. */
      name: z.string(),
    }),
  ])
  // One entry, as a second `register` would replace the first's description.
  .register(z.globalRegistry, {
    id: "Submitter",
    description:
      "Who submitted a Batch or a job, by `kind`: `key`, an API key, or `member`, a member signed in with their session. A release that adds a `kind` marks it as a breaking change.",
  });
export type Submitter = z.infer<typeof submitterSchema>;

/** What a job reports whatever its status. */
const jobBaseSchema = z.object({
  id: jobIdSchema,
  createdAt: z.date(),
  /** When the job's agent started on its Runner, once it has. */
  startedAt: z.nullable(z.date()),
  /** When the job's agent finished, once it has. */
  endedAt: z.nullable(z.date()),
  /**
   * The job's model usage so far, as pi counts it: every model call of the job's agent and its
   * sub-agents, including those made inside tools. Zeros until the job runs.
   */
  usage: usageSchema,
  /**
   * How long the job may work each time it runs on a Runner, in seconds: counted from when its
   * agent starts there, so time queued, paused or waiting for a Runner counts nothing, and started
   * afresh by a resume and by its Runner's restart. Past it, the job fails with `runTimedOut`.
   * Absent once the job is deleted, as its content is.
   */
  runTimeoutSeconds: z.optional(z.int()),
  /**
   * The most the job's model calls may cost over its whole life, in US dollars, compared with
   * `usage.cost.totalUsd` before each model call. Once the cost reaches it, the job fails with
   * `modelBudgetExceeded`; the call in progress completes, so the cost usually ends a little past
   * it. Absent once the job is deleted, as its content is.
   */
  modelBudgetUsd: z.optional(modelBudgetUsdSchema),
  /**
   * What the job is doing, for each of its conversations doing anything, as its Runner last
   * reported: present only while the job runs, and empty between steps.
   */
  activity: z.optional(jobActivitySchema),
  /**
   * A control the job's Runner has not yet acted on, beside the last `status` it confirmed: present
   * only while it waits. A pause or cancel waits for a job its Runner may be running, until
   * the Runner stops the job, which is then `paused` or ends `cancelled`, or the job ends first,
   * with its own status and output. A cancel replaces a waiting pause. A delete waits for the job's
   * Runner to delete its files from its host.
   */
  pendingControl: z.optional(
    z.object({ type: z.enum(["pause", "cancel", "delete"]), requestedAt: z.date() }),
  ),
  /**
   * When the job was deleted, present only while its Runner still deletes its files: the job reads
   * without its content, and as not found once they are gone.
   */
  deletedAt: z.optional(z.date()),
  /** The job's Batch, by its `id`. Absent once the job is deleted, as its content is. */
  batchId: z.optional(batchIdSchema),
  /** The caller's own ID for the job, unique in its Batch. Absent once the job is deleted. */
  customId: z.optional(z.string()),
  /** Who added the job to its Batch, as recorded then. Absent once the job is deleted. */
  submitter: z.optional(submitterSchema),
  /** The job's labels, its Batch's included. Absent once the job is deleted, as its content is. */
  labels: z.optional(labelsSchema),
  /**
   * What keeps a queued job from being sent to a Runner, to start or to carry on after a resume,
   * present only while something does: its Batch paused by a caller (`batchPausedByCaller`) or by
   * its failure breaker (`batchPausedByBreaker`), or its Batch's Canary still running
   * (`batchCanary`). A block changes no status: the job stays `queued`, and is sent once nothing
   * blocks it and a Runner has room. New values may be added.
   */
  blockedBy: z.optional(blockedBySchema),
  /**
   * The Runner the job was last sent to, as the hub knows it now: absent before the job is first
   * sent, once that Runner is removed, and once the job is deleted.
   */
  runner: z.optional(
    z.pick(runnerSchema, { id: true, name: true, lastSeenAt: true, connected: true }),
  ),
  /**
   * When the job's Runner last reported its current run, to within ten seconds: null until the run
   * first reports, as after a resume, which starts a new run, and once the job is deleted. Its
   * `usage` and `activity` are as of then or earlier, as a report may leave out one it cannot read.
   */
  lastReportedAt: z.nullable(z.date()),
  /**
   * Present while the hub cannot confirm the job's `status`, which is then its recorded status:
   * for a job sent to a Runner and not yet ended, paused or cancelled, when the job has
   * not been reported, nor placed, within two minutes. `reason` says why: its Runner has not been
   * heard from either (`runnerDisconnected`), or has, but has not reported this job
   * (`notReported`). The job may still be running there, and its Runner carries on from where it
   * was once it reports again; nothing ends it meanwhile. A cancel or pause waits for its Runner to
   * confirm it, and a job in its Batch's Canary holds the Batch's other jobs until it ends; removing
   * the Runner ends it, with the Runner's other unfinished jobs. A Runner can stop reporting one job
   * while it reports others, as when that job's journal cannot be read. New reasons may be added.
   * `since` is when the status became unknown, two minutes after the job was last reported or
   * placed, and stays while it lasts, whatever the reason; only a report whose write took the hub
   * two minutes or more moves it.
   */
  statusUnknown: z.optional(
    z.object({ reason: z.enum(["runnerDisconnected", "notReported"]), since: z.date() }),
  ),
});

/**
 * A job as the hub reports it: once it has succeeded, with its `output`, and once it has failed,
 * with its `failure`. Only a caller pauses or cancels a job, so `paused` and `cancelled` carry no
 * reason.
 */
export const jobSchema = z
  .discriminatedUnion("status", [
    z.extend(jobBaseSchema, { status: z.enum(["queued", "running", "paused", "cancelled"]) }),
    z.extend(jobBaseSchema, {
      status: z.literal("succeeded"),
      /** The job's output. Absent once the job is deleted, as its content is. */
      output: z.optional(z.unknown()),
    }),
    z.extend(jobBaseSchema, {
      status: z.literal("failed"),
      /** Why the job failed. Its message is absent once the job is deleted, as its content is. */
      failure: failureSchema,
    }),
  ])
  .register(z.globalRegistry, { id: "Job" });
export type Job = z.infer<typeof jobSchema>;

/** What keeps a queued job from being sent to a Runner (`Job["blockedBy"]`). */
export type BlockedBy = NonNullable<Job["blockedBy"]>;

/** Why the hub cannot confirm a job's status (`Job["statusUnknown"]`). */
export type StatusUnknownReason = NonNullable<Job["statusUnknown"]>["reason"];

/** A job's Runner as the job shows it (`Job["runner"]`). */
export type JobRunner = NonNullable<Job["runner"]>;

/**
 * An agent as a Batch's creation gives it: what every job of the Batch runs, each on its own input.
 * It is set once, as the Canary tests it.
 */
export const agentSchema = z
  .strictObject({
    instructions: z.optional(
      instructionsSchema.check(
        z.describe(
          "What the agent is told for every job, after the Runner's own instructions and before the job's `input`; none by default.",
        ),
      ),
    ),
    outputContract: strictOutputContractSchema.check(
      z.describe("What each job's output must be: `schema`, a JSON Schema the output must match."),
    ),
    runTimeoutSeconds: z.optional(
      runTimeoutSecondsSchema.check(
        z.describe(
          "How long each run of a job on a Runner may work, in seconds. Leaving it out when creating a Batch uses the hub's default. See `GET /jobs/limits` for the default and the largest accepted timeout.",
        ),
      ),
    ),
    modelBudgetUsd: z.optional(
      modelBudgetUsdSchema.check(
        z.describe(
          "Each job's model budget over its whole life, in US dollars. Leaving it out when creating a Batch uses the hub's default. See `GET /jobs/limits` for the default and the largest accepted budget.",
        ),
      ),
    ),
  })
  .register(z.globalRegistry, { id: "Agent" });
export type Agent = z.infer<typeof agentSchema>;

/** The failure breaker's defaults: a Canary of 5 jobs, then at most 10% of jobs failed. */
export const BREAKER_DEFAULTS = { canary: 5, maxFailurePercent: 10 } as const;

/** How many jobs each Canary holds; 0 for none. */
const canarySchema = z.int32().check(z.nonnegative());
/** The share of failed jobs among those ended since the Canary began, as a percentage, past which the Batch pauses. */
const maxFailurePercentSchema = z.number().check(z.minimum(0), z.maximum(100));

/** A Batch's failure breaker, as the hub reports it: off, or its settings. */
const breakerSchema = z.union([
  z.literal(false),
  z.object({ canary: canarySchema, maxFailurePercent: maxFailurePercentSchema }),
]);

/** A job as a caller adds it to a Batch, whose agent it runs. */
export const jobSubmissionSchema = z
  .strictObject({
    customId: customIdSchema.check(
      z.describe(
        "Your own ID for the job, unique in its Batch, given only once per call and reused if you retry the add.",
      ),
    ),
    input: z.optional(
      inputSchema.check(
        z.describe(
          "What the job gives the Batch's agent to work on: the agent's first input, after its instructions. Optional for a job with its own `files`, which are then what it works on; a job with neither is refused.",
        ),
      ),
    ),
    // Defaults to none, so a job without them is the same job as one with an empty list.
    files: z._default(
      inputFilesSchema.check(
        z.describe(
          "Files the job's agent finds in its Workspace's `inputs/` folder, at their paths; none by default. Each is a `path`, such as `invoice.pdf` or `claims/42/photo.jpg`, and the `digest` and `sizeBytes` of a Blob the Organization uploaded with `PUT /blobs/{digest}`, or that another of its jobs uses; any other Blob is refused.",
        ),
      ),
      [],
    ),
    labels: z._default(
      labelsSchema.check(
        z.describe(
          `Labels to find the job, group it and attribute its cost by, by key, such as \`{ "customer": "acme" }\`, beside its Batch's, which they win over where both name a key; none by default. Keys follow Kubernetes's label key syntax; values are any text of at most 256 characters, kept exactly as given. At most ${MAX_LABELS}, the Batch's and the job's own together.`,
        ),
      ),
      {},
    ),
  })
  .register(z.globalRegistry, { id: "JobSubmission" });
export type JobSubmission = z.infer<typeof jobSubmissionSchema>;

/**
 * The most jobs one request, a creation or an add, carries: it bounds the job rows one transaction
 * inserts and the jobs its answer gives, which the body's size does not, as a job naming its Input
 * files is small in the request. The rows of those files are bounded by the size alone (ADR 0050).
 */
export const MAX_JOBS_PER_REQUEST = 1000;

/** What `uniqueCustomIds` reads of an item: its `customId`, where it is text. */
const withCustomIdSchema = z.object({ customId: z.string() });

/**
 * Refuses each item of a list whose `customId` another item has, the first one included. The words
 * name the repeated ID and no index: the pointer already says where, and callers count items
 * differently (the CLI's "job N" counts from 1), so an index would point some of them at the wrong
 * item; without one, each place is told.
 */
const uniqueCustomIds = z.superRefine(
  (items: readonly unknown[], context) => {
    const ids = items.flatMap((item, index) => {
      const read = z.safeParse(withCustomIdSchema, item);
      return read.success ? [{ index, customId: read.data.customId }] : [];
    });
    const uses = Map.groupBy(ids, (id) => id.customId);
    // Among themselves in the request's order. Zod reports them after the jobs' own problems, as it
    // runs a list's checks after its items'.
    for (const { index, customId } of ids) {
      if ((uses.get(customId)?.length ?? 0) < 2) continue;
      context.addIssue({
        code: "custom",
        message: `Must be unique in the request: ${JSON.stringify(customId)} is given more than once`,
        path: [index, "customId"],
        input: customId,
      });
    }
  },
  // Zod skips a refinement once another part of the list failed to parse; this one reads only the
  // IDs it can, so a repeat is answered with the request's other problems. Zod hands it the list as
  // parsed so far, malformed items included.
  { when: ({ value }) => Array.isArray(value) },
);

const submittedJobsSchema = z
  .array(jobSubmissionSchema)
  .check(
    z.minLength(1),
    z.maxLength(MAX_JOBS_PER_REQUEST),
    uniqueCustomIds,
    z.describe(
      "The jobs to add in this call. Each new job takes the timeout and model budget stored on the Batch at creation, even if the defaults or maxima at `GET /jobs/limits` have since changed. For a larger Batch, add more jobs with the same Batch ID in later calls.",
    ),
  );

/** A Batch as a caller creates it. */
export const batchCreationSchema = z
  .strictObject({
    id: z.optional(
      batchIdSchema.check(
        z.describe(
          "The Batch's ID, unique in the Organization, which names it in every call; a UUID is made for it when left out. 1 to 100 letters, digits, `_` and `-`, not beginning with `-`, compared exactly, so `Invoices` and `invoices` are two Batches. Creating a Batch again with the same `id` and the same `agent`, `labels` and `breaker` returns the Batch already created, so a creation can be retried safely; with any of them different it is refused. A new Batch needs a new ID.",
        ),
      ),
    ),
    agent: agentSchema,
    jobs: z.optional(submittedJobsSchema),
    labels: z._default(
      labelsSchema.check(
        z.describe(
          `Labels every job of the Batch gets, beside its own, which win where both name a key; none by default. Keys follow Kubernetes's label key syntax; values are any text of at most 256 characters, kept exactly as given. A job has at most ${MAX_LABELS} labels, the Batch's and its own together, so a job whose own labels take it past that is refused.`,
        ),
      ),
      {},
    ),
    breaker: z
      ._default(
        z.union([
          z.boolean(),
          z.strictObject({
            canary: z.optional(canarySchema),
            maxFailurePercent: z.optional(maxFailurePercentSchema),
          }),
        ]),
        true,
      )
      .check(
        z.describe(
          "The failure breaker, which pauses the Batch when a flaw its jobs share shows, after a few jobs instead of after all of them. The Batch's first `canary` jobs (5 by default), its Canary, run before the rest are released, and any of them failing pauses the Batch. Once every Canary place is filled and its jobs have ended, it pauses when more than `maxFailurePercent` (10 by default) of the jobs ended since the Canary began have failed. A job counts once, by its latest end; a job that a limit stopped counts as failed, while a cancelled job, or one its Runner's removal ended, does not count. Resuming a pause the breaker made starts a new Canary of the next `canary` jobs, those added later included. `canary: 0` releases every job at once, and the percentage then judges from the first job to end, so one early failure still pauses the Batch; `maxFailurePercent: 100` keeps the Canary alone. `true` by default, for the defaults; `false` turns the breaker off.",
        ),
      ),
  })
  .register(z.globalRegistry, { id: "BatchCreation" });
export type BatchCreation = z.infer<typeof batchCreationSchema>;

/** Where a Batch is: releasing its jobs, paused, or cancelled. */
export const batchStatusSchema = z.enum(["active", "paused", "cancelled"]);

/** A Batch as the hub reports it. */
export const batchSchema = z
  .object({
    /** The ID its creation gave it, or the UUID made for it. */
    id: batchIdSchema,
    createdAt: z.date(),
    /**
     * `active` while it releases its jobs, an empty Batch and one whose jobs have all ended included,
     * and while a cancel waits, as `pendingControl` shows; `paused` while it is paused, whether or not
     * any job is unfinished, as jobs added to it are held; `cancelled` once it was cancelled and every
     * job has ended. A Batch has no status of its own for having no unfinished job: `jobCounts` tells.
     */
    status: batchStatusSchema,
    /** Who created the Batch, as recorded then; each of its jobs records who added it. */
    submitter: submitterSchema,
    /** Who paused the Batch, a caller or its failure breaker; null while it is not paused. */
    pausedBy: z.nullable(z.enum(["caller", "breaker"])),
    /** A cancel waiting for its jobs' Runners to stop them, present only while it waits. */
    pendingControl: z.optional(z.object({ type: z.literal("cancel"), requestedAt: z.date() })),
    labels: labelsSchema,
    breaker: breakerSchema,
    /** How many of its jobs have each status; a deleted job is not counted. */
    jobCounts: z.object({
      queued: z.int(),
      running: z.int(),
      paused: z.int(),
      succeeded: z.int(),
      failed: z.int(),
      cancelled: z.int(),
    }),
    /**
     * How many of its jobs show each `blockedBy` reason. Each is also counted in
     * `jobCounts.queued`. New reasons may be added.
     */
    // An object, not a record keyed by the enum, so an older client drops a reason a newer hub
    // adds instead of refusing the Batch; `satisfies` keeps a key for every reason.
    blockedJobCounts: z.object({
      batchPausedByCaller: z.int(),
      batchPausedByBreaker: z.int(),
      batchCanary: z.int(),
    } satisfies Record<z.infer<typeof blockedBySchema>, unknown>),
    /**
     * How many of its jobs show `statusUnknown`: each is also counted in `jobCounts`, under its
     * recorded status.
     */
    statusUnknownJobs: z.int(),
    /**
     * Its jobs' model usage, as each job reports its own; a deleted job's is not included, and stays
     * in its Usage records.
     */
    usage: usageSchema,
  })
  .register(z.globalRegistry, { id: "Batch" });
export type Batch = z.infer<typeof batchSchema>;
export type BatchStatus = z.infer<typeof batchStatusSchema>;

/**
 * The Organization's unfinished jobs now, counted at one moment, as a Batch counts its own: by
 * status, and those whose status the hub cannot confirm. Ended jobs are left out: counting them
 * would read every job the Organization has kept.
 */
export const jobCountsSchema = z
  .object({
    /** How many jobs have each unfinished status. */
    jobCounts: z.pick(batchSchema.shape.jobCounts, { queued: true, running: true, paused: true }),
    /** How many queued and running jobs show `statusUnknown`. Each is also counted in `jobCounts`. */
    statusUnknownJobCounts: z.pick(batchSchema.shape.jobCounts, { queued: true, running: true }),
  })
  .register(z.globalRegistry, { id: "JobCounts" });
export type JobCounts = z.infer<typeof jobCountsSchema>;

/**
 * The hub's current job limits. Each default applies at Batch creation when the field is omitted.
 * A value supplied at creation or resume may be at most the corresponding `max`, inclusive.
 */
export const jobLimitsSchema = z
  .object({
    /** How long each run may work, in seconds. */
    runTimeoutSeconds: z.object({ default: runTimeoutSecondsSchema, max: runTimeoutSecondsSchema }),
    /** The total model budget for one job across all its runs, in US dollars. */
    modelBudgetUsd: z.object({ default: modelBudgetUsdSchema, max: modelBudgetUsdSchema }),
  })
  .register(z.globalRegistry, { id: "JobLimits" });
export type JobLimits = z.infer<typeof jobLimitsSchema>;

/**
 * A Batch as a list shows it: without its `usage`, which only reading every job's progress tells,
 * so a list of large Batches stays quick; read the Batch for it.
 */
export const listedBatchSchema = z
  .omit(batchSchema, { usage: true })
  .register(z.globalRegistry, { id: "ListedBatch" });
export type ListedBatch = z.infer<typeof listedBatchSchema>;

/** A page of Batches, newest first. */
export const batchesPageSchema = z
  .object({ batches: z.array(listedBatchSchema), hasMore: z.boolean() })
  .register(z.globalRegistry, { id: "BatchesPage" });
export type BatchesPage = z.infer<typeof batchesPageSchema>;

/**
 * A job as a creation or an add answers it, by its IDs alone. A submission's answer is bounded by
 * its request, so it names what was made and whether this call made it, and anything else about a
 * job is read from the job (ADR 0050).
 */
export const jobIdsSchema = z
  .required(z.pick(jobBaseSchema, { id: true, customId: true }), { customId: true })
  .register(z.globalRegistry, {
    id: "JobIds",
    description:
      "A job by its `id` and `customId`. Read the job by its `id`, or list the Batch's jobs, for how it stands.",
  });
export type JobIds = z.infer<typeof jobIdsSchema>;

/**
 * A job a creation or an add asked for, and whether this call created it. A retry after a lost
 * response returns `created: false`, so once-per-job work cannot depend on it.
 */
export const addedJobSchema = z.object({ created: z.boolean(), job: jobIdsSchema });

/** The Batch and the jobs requested at creation, in request order. */
export const createdBatchSchema = z
  .extend(batchSchema, { jobs: z.array(addedJobSchema) })
  .register(z.globalRegistry, { id: "CreatedBatch" });
export type CreatedBatch = z.infer<typeof createdBatchSchema>;

/** The jobs an add asked for, in its order, each with whether the add created it, and their Batch. */
export const addedJobsSchema = z
  .object({ batch: batchSchema, jobs: z.array(addedJobSchema) })
  .register(z.globalRegistry, { id: "AddedJobs" });
export type AddedJobs = z.infer<typeof addedJobsSchema>;

/** A Batch as a call names it. */
export const batchRefSchema = z.strictObject({
  id: batchIdSchema.check(z.describe("The Batch's ID.")),
});

/**
 * A job as a list reports it: without its content, so without its output, its failure's message
 * and its activity. Read the job for those.
 */
const listedJobBaseSchema = z.required(z.omit(jobBaseSchema, { activity: true }), {
  // Deletion removes the job's row, so only a deleted job's detail, read from its deletion
  // snapshot, lacks these. The list reads the job table.
  batchId: true,
  customId: true,
  labels: true,
  submitter: true,
  runTimeoutSeconds: true,
  modelBudgetUsd: true,
});
export const listedJobSchema = z
  .discriminatedUnion("status", [
    z.extend(listedJobBaseSchema, {
      status: z.enum(["queued", "running", "paused", "succeeded", "cancelled"]),
    }),
    z.extend(listedJobBaseSchema, {
      status: z.literal("failed"),
      failure: z.pick(failureSchema, { reason: true }),
    }),
  ])
  .register(z.globalRegistry, { id: "ListedJob" });
export type ListedJob = z.infer<typeof listedJobSchema>;

/** A page of jobs, newest first. A caller reads the next page after the last job's `id` while `hasMore`. */
export const jobsPageSchema = z
  .object({ jobs: z.array(listedJobSchema), hasMore: z.boolean() })
  .register(z.globalRegistry, { id: "JobsPage" });
export type JobsPage = z.infer<typeof jobsPageSchema>;

const jobEventOrderSchema = z
  .enum(["asc", "desc"])
  .check(z.describe("Event ID order, oldest first (asc, the default) or newest first (desc)."));
export type JobEventOrder = z.infer<typeof jobEventOrderSchema>;

/** Follow a job in ascending order until a page with a final `status` has no more events. */
export const jobEventsPageSchema = z
  .object({
    events: z
      .array(jobEventSchema)
      .check(z.describe("Events past the cursor, in the requested order.")),
    hasMore: z
      .boolean()
      .check(
        z.describe(
          "Whether more events are already stored past this page in that order. In descending order, false means the start of the stored history has been reached.",
        ),
      ),
    status: jobStatusSchema.check(
      z.describe(
        "The job's status when this page was read. It equals `job.status` on a page that carries the job.",
      ),
    ),
    job: z
      .optional(jobSchema)
      .check(
        z.describe(
          "The job when this page was read, in the same snapshot as its Events. Present on ascending pages with `hasMore: false` and descending pages read from the newest end (`after: 0`). Other pages omit the job because its Output can make it far larger than a page of Events.",
        ),
      ),
  })
  .register(z.globalRegistry, { id: "JobEventsPage" });
export type JobEventsPage = z.infer<typeof jobEventsPageSchema>;

/** The most days one read of usage covers. */
export const MAX_USAGE_DAYS = 400;

const usageDaysPattern = new RegExp(`^([1-9][0-9]{0,${String(MAX_USAGE_DAYS).length - 1}})d$`);
const usageMonthPattern =
  /^(?:000[1-9]|00[1-9][0-9]|0[1-9][0-9]{2}|[1-9][0-9]{3})-(?:0[1-9]|1[0-2])$/;

/** Read a rolling number of UTC days or a calendar month in the wire format of `period`. */
export function parseUsagePeriod(value: string) {
  const days = usageDaysPattern.exec(value);
  if (days) {
    const count = Number(days[1]);
    if (count <= MAX_USAGE_DAYS) return { kind: "days" as const, days: count };
  } else if (usageMonthPattern.test(value)) {
    return { kind: "month" as const, month: value };
  }
  return undefined;
}

export const USAGE_PERIOD_ERROR = `Must be 1d through ${MAX_USAGE_DAYS}d or a calendar month as YYYY-MM, from year 0001`;

export const usagePeriodSchema = z.string().check(
  z.refine((value) => parseUsagePeriod(value) !== undefined, {
    error: USAGE_PERIOD_ERROR,
  }),
  z.meta({ anyOf: [{ pattern: usageDaysPattern.source }, { pattern: usageMonthPattern.source }] }),
);

/** A calendar day, as `YYYY-MM-DD`. */
const dateSchema = z.iso.date();

/**
 * What a read of usage groups it by: the jobs' Batch, who submitted them, the Runner
 * they last ran on, the status they ended in, or the value of one of their labels, as
 * `label:customer`.
 */
export const usageGroupBySchema = z.union(
  [
    z.enum(["batch", "submitter", "runner", "status"]),
    z.templateLiteral(["label:", labelKeySchema]),
  ],
  { error: "Must be `batch`, `submitter`, `runner`, `status` or `label:` and a label key" },
);
export type UsageGroupBy = z.infer<typeof usageGroupBySchema>;

/** Job ends and the usage they account for in a window, day or group. */
const usageCountSchema = z.object({
  /** Each end of a job counts once, including each end after a resume. */
  jobEnds: z.int(),
  usage: usageSchema,
});

/**
 * One group of usage, named by the one field of what the read groups by: `batchId`, the Batch's
 * ID; `submitter`, who submitted the jobs, with the name its latest record in the window holds,
 * the one recorded last, by `recordedAt` and then by order of writing; `runner`, the Runner the jobs last ran on, with its name while the Runner
 * exists, as a job shows it, or null for jobs that ended before a Runner started them; `status`, the
 * status the jobs ended in; or `labelValue`, the label's value, null for jobs without that label.
 */
export const usageGroupSchema = z
  .union([
    z.extend(usageCountSchema, { batchId: batchIdSchema }),
    z.extend(usageCountSchema, { submitter: submitterSchema }),
    z.extend(usageCountSchema, {
      runner: z.nullable(z.object({ id: z.string(), name: z.optional(z.string()) })),
    }),
    z.extend(usageCountSchema, { status: finalJobStatusSchema }),
    z.extend(usageCountSchema, { labelValue: z.nullable(z.string()) }),
  ])
  .register(z.globalRegistry, { id: "UsageGroup" });
export type UsageGroup = z.infer<typeof usageGroupSchema>;
export const usageGroupsSchema = z.array(usageGroupSchema);

const usageWindowSchema = z.extend(usageCountSchema, {
  /** The window's first day, a UTC day. */
  from: dateSchema,
  /** The window's last UTC day, included, capped at today. */
  to: dateSchema,
  /** The hub's UTC day at the read, still being recorded. */
  today: dateSchema,
  /** When the figures were read, by the hub's clock. */
  readAt: z.date(),
  /** Every UTC day of the window, oldest first, including days without job ends. */
  days: z.array(z.extend(usageCountSchema, { date: dateSchema })),
});

export const usageReportSchema = z.union([
  z
    .extend(usageWindowSchema, { groups: z.optional(z.never()), other: z.optional(z.never()) })
    .register(z.globalRegistry, {
      id: "UngroupedUsageReport",
      description: "Without `groupBy`, job ends and model usage for the window and each day.",
    }),
  z
    .extend(usageWindowSchema, {
      /** At most `limit` groups, highest cost first, then most tokens, then in a fixed order. */
      groups: usageGroupsSchema,
      /** The remaining groups counted and summed, all zeros when none remain. */
      other: z.extend(usageCountSchema, { groups: z.int() }),
    })
    .register(z.globalRegistry, {
      id: "GroupedUsageReport",
      description:
        "With `groupBy`, job ends and model usage for the window, each day and the ranked groups.",
    }),
]);
export type UsageReport = z.infer<typeof usageReportSchema>;

/** A name a person gives, such as the Organization's or a member's. */
const nameSchema = textSchema.check(z.trim(), z.minLength(1));

const invitationInput = z.strictObject({ invitationId: textSchema });
const invitationFields = z.object({ email: z.email(), role: z.string(), expiresAt: z.date() });
export const InvitationUnavailable = error("NOT_FOUND", {
  message: "This invitation is no longer available",
});

/** A setup link the hub did not issue, or one it no longer accepts. */
export const SetupLinkRefused = error("FORBIDDEN", {
  message:
    "The setup link is not valid: it may have been used, replaced by a newer one or be more than a day old. Restarting the hub, or running `vp run setup` for a hub on Workers, prints a new one.",
});
/** Setting up a hub that is already set up. */
export const AlreadySetUp = error("CONFLICT", { message: "The hub is already set up" });
/**
 * A control that cannot take effect on the job or Batch as it is, such as a resume of a job that
 * succeeded, or jobs added to a cancelled Batch; its message says why.
 */
export const ControlRefused = error("CONFLICT");
/**
 * A Batch created under an ID, or jobs added under custom IDs, already used for one with other
 * content; its message names each.
 */
export const IdReused = error("UNPROCESSABLE_CONTENT");

// Calls a member's role does not allow fail with `FORBIDDEN`, and invalid ones with `BAD_REQUEST`.
// Better Auth checks the member's role when creating or revoking API keys and the hub passes its
// refusal through. The hub checks the role itself when listing API keys, removing a Runner or
// reading usage. It raises `BAD_REQUEST` for what the contract's schemas cannot check, such as an
// Output contract's schema.

/**
 * The most bytes a request's body may hold, other than an upload's, which may hold a file
 * (`MAX_FILE_BYTES`): the hub reads such a body whole and parses it before handling the request,
 * and a Workers isolate has 128 MB for every request it serves. A larger body is refused with 413.
 */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** The most files one check of stored Blobs names. */
export const MAX_FILES_PER_CHECK = 1000;

/**
 * Whether the Organization holds a file's Blob, as a check answers it, and if not, where to
 * upload it: `transfer` names how, `put` being one request carrying the whole file, so other ways,
 * such as resumable uploads, can follow.
 */
const blobCheckSchema = z.discriminatedUnion("stored", [
  z.extend(blobRefSchema, { stored: z.literal(true) }),
  z.extend(blobRefSchema, {
    stored: z.literal(false),
    upload: z.object({
      transfer: z.literal("put"),
      url: z
        .string()
        .check(z.describe("Where to `PUT` the file's bytes, relative to the hub's URL.")),
    }),
  }),
]);

const statusFilterDescription = z.describe(
  "Any of the given statuses. Omit the filter to include every status. An empty list also includes every status.",
);
const labelFilterSchema = z.optional(
  z
    .record(labelKeySchema, labelValueSchema)
    .check(z.describe("Label key/value pairs that must all match.")),
);

// Optional because released calls such as `client.runners.list()` take no argument.
const noQueryParametersSchema = z.optional(z.strictObject({}));

/**
 * The hub's public HTTP API, for people and their programs. Callers sign in as a member or send an
 * API key in `x-api-key`. A Runner's own calls are `runnerHttpContract`'s.
 *
 * Inputs are strict: a parameter the API does not define, in a body or a read's query string, is
 * refused with 400 naming it (ADR 0010). Writes define no query parameters, and their query strings
 * are ignored. oRPC omits them from compact inputs, and the upload's schema drops its query string.
 * Answers and the upload's headers stay open so the hub can add fields without breaking callers.
 */
export const apiContract = oc.errors({ BAD_REQUEST: {} }).router({
  setup: {
    get: forAnyone
      .meta(
        openapi({
          method: "GET",
          path: "/setup",
          description:
            "Whether the hub still needs setting up: true until its Organization and owner exist, so the dashboard knows to offer setup.",
        }),
        ...byAnyone,
      )
      .input(noQueryParametersSchema)
      .output(z.object({ needed: z.boolean() })),
    complete: forAnyone
      .errors({
        UNPROCESSABLE_CONTENT: {},
        [SetupLinkRefused.code]: SetupLinkRefused,
        [AlreadySetUp.code]: AlreadySetUp,
      })
      .meta(
        openapi({
          method: "POST",
          path: "/setup",
          description:
            "Sets the hub up: creates its Organization, named `organizationName`, and its owner, named `name`, who then signs in with this email and password. `token` is the part after `#` of the setup link the hub printed when it started without an owner, or that `vp run setup` printed for a hub on Workers.",
        }),
        ...byAnyone,
      )
      .input(
        z.strictObject({
          token: textSchema,
          organizationName: nameSchema,
          name: nameSchema,
          email: z.email(),
          password: passwordSchema,
        }),
      ),
  },
  invitations: {
    // POST keeps the bearer ID in the body, away from logged URLs, as setup does.
    preview: forAnyone
      .errors({ [InvitationUnavailable.code]: InvitationUnavailable })
      .meta(
        openapi({
          method: "POST",
          path: "/invitations/preview",
          description: "Shows who an invitation is for and the role it grants.",
        }),
        ...byAnyone,
      )
      .input(invitationInput)
      .output(z.extend(invitationFields, { organizationName: z.string() })),
    accept: forAnyone
      .errors({
        [InvitationUnavailable.code]: InvitationUnavailable,
        UNAUTHORIZED: {},
        FORBIDDEN: {},
        // Another registration can win the account insert after lookup. The claim rolls back
        // and the invitation stays usable.
        UNPROCESSABLE_CONTENT: {},
      })
      .meta(
        openapi({
          method: "POST",
          path: "/invitations/accept",
          description:
            "Joins the Organization once. A new account supplies a name and password. An existing account signs in first.",
        }),
        ...byAnyone,
        openapi.spec((operation): typeof operation => ({
          ...operation,
          security: [{}, { session: [] }],
        })),
      )
      .input(
        z.extend(invitationInput, {
          name: z.optional(nameSchema),
          password: z.optional(passwordSchema),
        }),
      )
      .output(z.object({ email: z.email() })),
    list: forMembers
      .meta(
        openapi({
          method: "GET",
          path: "/invitations",
          description: "Lists pending invitations the member may grant, newest first.",
        }),
        ...byMember,
      )
      .input(noQueryParametersSchema)
      .output(
        z.array(
          z.extend(invitationFields, {
            id: z.string(),
            inviter: z.object({ id: z.string(), name: z.string() }),
            createdAt: z.date(),
          }),
        ),
      ),
  },
  runners: {
    list: forMembers
      .meta(
        openapi({
          method: "GET",
          path: "/runners",
          description:
            "Lists the Runners, when each was last seen, and the capabilities it reported.",
        }),
        ...byKeyOrMember({ runner: ["read"] }),
      )
      .input(noQueryParametersSchema)
      .output(z.array(runnerSchema)),
    // Removing a Runner ends the jobs it held that have not ended.
    delete: forMembers
      .errors({ [NotFound.code]: NotFound })
      .meta(
        openapi({
          method: "DELETE",
          path: "/runners/{id}",
          description:
            "Removes a Runner, for a host that is retired or compromised: its own key stops working and its connection is dropped at once. Revoke any still-valid registration key a compromised host holds so it cannot register again. Registered Runners keep working with their own keys. Nothing the host holds can be run, resumed or removed through the hub again, so the jobs the Runner held that had not ended end: `cancelled` where a cancel was waiting, otherwise `failed` with reason `runnerRemoved`. They may still run on the host unseen. The answer lists the jobs it ended, and every job whose files the host may still hold, which whoever looks after the host can remove.",
        }),
        ...byMember,
      )
      .input(z.strictObject({ id: z.string() }))
      .output(
        z.object({
          endedJobs: z.array(jobIdSchema).check(z.describe("The jobs the removal ended.")),
          jobsWithFilesLeft: z
            .array(jobIdSchema)
            .check(
              z.describe(
                "The jobs whose files the Runner's host may still hold, those ended included.",
              ),
            ),
        }),
      ),
  },
  apiKeys: {
    create: forMembers
      .meta(openapi({ method: "POST", path: "/api-keys" }), ...byMember)
      .input(
        z.strictObject({
          // Better Auth and the form count UTF-16 code units, while Zod's maxLength and JSON Schema
          // count code points. Refuse the name once by the hub's measure and publish maxLength.
          name: z.string().check(
            z.refine((value) => value.length <= MAX_API_KEY_NAME_LENGTH, {
              error: `At most ${MAX_API_KEY_NAME_LENGTH} characters`,
              abort: true,
            }),
            z.maxLength(MAX_API_KEY_NAME_LENGTH),
            z.describe(`At most ${MAX_API_KEY_NAME_LENGTH} UTF-16 code units.`),
          ),
          permissions: permissionsSchema,
          expiresIn: z.optional(
            z
              .number()
              .check(
                z.describe(
                  "Seconds until the key stops working, from one day to a year; without it, it never does.",
                ),
              ),
          ),
        }),
      )
      .output(createdKeySchema),
    list: forMembers
      .meta(
        openapi({
          method: "GET",
          path: "/api-keys",
          description:
            "Lists the Organization's unexpired API keys other than Runners' own. Only owners and admins may list them. Other members are refused with 403.",
        }),
        ...byMember,
      )
      .input(noQueryParametersSchema)
      .output(z.array(apiKeySchema)),
    revoke: forMembers
      .errors({ [NotFound.code]: NotFound })
      .meta(openapi({ method: "DELETE", path: "/api-keys/{id}" }), ...byMember)
      .input(z.strictObject({ id: z.string() })),
  },
  blobs: {
    check: forMembers
      .meta(
        openapi({
          method: "POST",
          path: "/blobs/check",
          description: `Answers, for each file named by \`digest\` and \`sizeBytes\`, in the order given, whether the Organization holds that Blob: \`stored: true\` when it uploaded it in the last seven days or one of its jobs uses it, so jobs may name it without uploading it again; otherwise \`stored: false\` and where to upload it. At most ${MAX_FILES_PER_CHECK} files per request. A file whose size is not that of the Blob the Organization holds with its digest is refused.`,
        }),
        ...byKeyOrMember({ job: ["create"] }),
      )
      .input(
        z.strictObject({
          files: z
            .array(strictBlobRefSchema)
            .check(
              z.minLength(1),
              z.maxLength(MAX_FILES_PER_CHECK),
              z.describe(`The files to check, 1 to ${MAX_FILES_PER_CHECK} per request.`),
            ),
        }),
      )
      .output(z.object({ files: z.array(blobCheckSchema) })),
    upload: forMembers
      .meta(
        openapi({
          method: "PUT",
          path: "/blobs/{digest}",
          // The body is handed over as it arrives, so the hub stores a file a chunk at a time.
          inputStructure: "detailed",
          requestBodyHint: "octet-stream",
          description: `Uploads a file's bytes as the request's body, at most ${MAX_FILE_BYTES / 1024 / 1024} MiB, with \`Content-Length\`, under its \`digest\`, and answers once the hub has checked the bytes' size and SHA-256 and stored them as a Blob. The Organization then holds the Blob for seven days, renewed by each upload of it, and as long as any of its jobs uses it after that. Bytes whose size or SHA-256 differ from what the request names are refused, and nothing is stored.`,
        }),
        ...byKeyOrMember({ job: ["create"] }),
      )
      .input(
        z.object({
          params: z.strictObject({ digest: digestSchema }),
          headers: z.object({
            // Coerced from the header's text by the hub's coercion plugin. A browser sends its own,
            // from a `Blob` body, and drops one its caller sets.
            "content-length": fileSizeBytesSchema.check(z.describe("The file's size in bytes.")),
          }),
          // The request's bytes: a stream, as a program reading a file sends them, or a `Blob`,
          // such as a `File`, as a browser sends them: the browser knows a `Blob`'s size and sends
          // the `Content-Length` the hub requires. The hub reads either as a stream, which oRPC
          // hands over without reading it first. Its JSON Schema is a file's.
          body: z.union([z.instanceof(ReadableStream<Uint8Array>), z.instanceof(Blob)]).check(
            z.meta({
              type: "string",
              format: "binary",
              contentMediaType: "application/octet-stream",
            }),
          ),
        }),
      )
      .output(blobRefSchema),
  },
  batches: {
    create: forMembers
      .errors({ [ControlRefused.code]: ControlRefused, [IdReused.code]: IdReused })
      .meta(
        // One status, 200, whether the Batch is new or a retry's, as for an add: no caller acts on
        // the difference, and a status per answer would make the typed client answer this one call
        // with `{ status, body }`.
        openapi({
          method: "POST",
          path: "/batches",
          description:
            "Creates a Batch and its optional first jobs, all or nothing. The answer is the Batch with each requested job in order, named by its `id` and `customId`, and whether it was created. A submission's answer is bounded by its request, so it says nothing else about a job: read the job, or the job list, for how it stands. The hub checks the request shape first, a `customId` given twice included. A malformed job is refused before the agent's Output schema is checked, so a malformed job and an array Output schema take two attempts to diagnose. Once the shape is valid, the hub reports job input problems together with Output schemas that are invalid, describe a list or refer outside themselves. When the Output schema is invalid, the same 400 response includes any agent limits above the hub's maxima. A new Batch must meet the current limits. Retrying the same ID, agent, labels and breaker returns the existing Batch even after a maximum is lowered. Different Batch content under the same ID is refused with 422. Each custom ID follows the add's rule: matching content returns the held job even after cancellation, different content is refused with 422, and a cancelled Batch takes no new jobs (409).",
        }),
        ...byKeyOrMember({ job: ["create"] }),
      )
      .input(batchCreationSchema)
      .output(createdBatchSchema),
    addJobs: forMembers
      .errors({
        [NotFound.code]: NotFound,
        [ControlRefused.code]: ControlRefused,
        [IdReused.code]: IdReused,
      })
      .meta(
        openapi({
          method: "POST",
          path: "/batches/{id}/jobs",
          description: `Adds jobs to a Batch, at most ${MAX_JOBS_PER_REQUEST} at a time, each running the Batch's agent on its own \`input\` and files, and answers with the Batch and each job in the order given, named by its \`id\` and \`customId\`, with whether this add created it. A submission's answer is bounded by its request, so it says nothing else about a job: read the job, or the job list, for how it stands. An add is all or nothing. The hub checks the request shape first, a \`customId\` given twice in the call included, and refuses a malformed add with 400 before it looks the Batch up; a well-formed add to a missing Batch is refused with 404. For an existing Batch, every job is then checked against it, and the add is refused with 400 if any is invalid, such as a job whose labels and the Batch's are too many together. The add is refused with 422 if the Batch already has a job with the same \`customId\` and different content, or with 409 if any job would be new and the Batch is cancelled. Each reported job problem names its path, such as \`jobs[17].input\`. On a successful add, a job the Batch still holds with the same \`customId\` and content is returned with \`created: false\`. Deleting a job frees its \`customId\`, so adding it again creates a new job with \`created: true\`. Jobs added to a paused Batch wait for it.`,
        }),
        ...byKeyOrMember({ job: ["create"] }),
      )
      .input(
        z.extend(batchRefSchema, {
          jobs: submittedJobsSchema,
        }),
      )
      .output(addedJobsSchema),
    list: forMembers
      .meta(
        openapi({
          method: "GET",
          path: "/batches",
          description:
            "Lists Batches, newest first, in pages of at most `limit`. Filters combine: a Batch is listed when it has one of the `status` values given and every label in `labels`, its own labels rather than its jobs'. Read the next page with the same filters and `after` set to the last Batch's `id`, while the page says `hasMore`; an `after` naming no Batch is refused. A listed Batch has no `usage`: read the Batch for it.",
          // Repeated `status=…` parameters, a single one included, read as a list.
          queryStyles: { status: "array" },
        }),
        ...byKeyOrMember({ job: ["read"] }),
      )
      .input(
        z.strictObject({
          status: z.optional(z.array(batchStatusSchema).check(statusFilterDescription)),
          labels: labelFilterSchema,
          after: z.optional(
            batchIdSchema.check(
              z.describe("The last Batch's ID on the previous page, to read on after it."),
            ),
          ),
          limit: z._default(
            z
              .int()
              .check(
                z.minimum(1),
                z.maximum(100),
                z.describe("At most this many Batches in the page, 50 by default."),
              ),
            50,
          ),
        }),
      )
      .output(batchesPageSchema),
    get: forMembers
      .errors({ [NotFound.code]: NotFound })
      .meta(
        openapi({ method: "GET", path: "/batches/{id}", description: "Reads a Batch." }),
        ...byKeyOrMember({ job: ["read"] }),
      )
      .input(batchRefSchema)
      .output(batchSchema),
    pause: forMembers
      .errors({ [NotFound.code]: NotFound, [ControlRefused.code]: ControlRefused })
      .meta(
        openapi({
          method: "POST",
          path: "/batches/{id}/pause",
          description:
            "Pauses a Batch and answers with it. Its jobs not yet sent to a Runner, and those added later, are blocked: they stay `queued`, with `blockedBy: batchPausedByCaller`. Jobs already being sent or running carry on to their own ends, so a pause stops only the jobs not already being sent. A pause changes no job's status. Pausing a paused Batch changes nothing; a cancelled one is refused.",
        }),
        ...byKeyOrMember({ job: ["pause"] }),
      )
      .input(batchRefSchema)
      .output(batchSchema),
    resume: forMembers
      .errors({ [NotFound.code]: NotFound, [ControlRefused.code]: ControlRefused })
      .meta(
        openapi({
          method: "POST",
          path: "/batches/{id}/resume",
          description:
            "Resumes a paused Batch and answers with it: its blocked jobs are released, behind its Canary while one runs. Resuming a pause its failure breaker made, or a caller's pause during which the breaker's rule tripped, restarts the breaker's counts and starts a new Canary of the next `canary` jobs, those added later included. A job paused by its own control stays paused. Resuming a Batch that is not paused changes nothing; a cancelled one is refused.",
        }),
        ...byKeyOrMember({ job: ["resume"] }),
      )
      .input(batchRefSchema)
      .output(batchSchema),
    cancel: forMembers
      .errors({ [NotFound.code]: NotFound })
      .meta(
        openapi({
          method: "POST",
          path: "/batches/{id}/cancel",
          description:
            "Cancels a Batch and answers with it: each unfinished job is cancelled as a job's cancel does, at once where no Runner may be running it and otherwise once its Runner stops it, shown meanwhile as the Batch's `pendingControl`. The Batch is `cancelled` once every job has ended. A cancel is final, also for a Batch whose jobs have all ended: the Batch takes no new jobs, and none of its jobs can be resumed. Cancelling a cancelled Batch changes nothing.",
        }),
        ...byKeyOrMember({ job: ["cancel"] }),
      )
      .input(batchRefSchema)
      .output(batchSchema),
  },
  jobs: {
    get: forMembers
      .errors({ [NotFound.code]: NotFound })
      .meta(
        openapi({ method: "GET", path: "/jobs/{id}", description: "Reads a job." }),
        ...byKeyOrMember({ job: ["read"] }),
      )
      .input(jobRefSchema)
      .output(jobSchema),
    pause: forMembers
      .errors({ [NotFound.code]: NotFound, [ControlRefused.code]: ControlRefused })
      .meta(
        openapi({
          method: "POST",
          path: "/jobs/{id}/pause",
          description:
            "Pauses a job and answers with the job. A job not yet sent to a Runner is held at once as `paused`. Otherwise the pause waits for its Runner, shown as `pendingControl`, and the job is `paused` once the Runner has stopped it, its work kept for a resume, holding no capacity. Pausing a paused job, or one whose pause waits, changes nothing; a job that has ended, or whose cancel waits, is refused.",
        }),
        ...byKeyOrMember({ job: ["pause"] }),
      )
      .input(jobRefSchema)
      .output(jobSchema),
    resume: forMembers
      .errors({
        [NotFound.code]: NotFound,
        [ControlRefused.code]: ControlRefused,
      })
      .meta(
        openapi({
          method: "POST",
          path: "/jobs/{id}/resume",
          description:
            "Resumes a stopped job and answers with the job. A paused, failed or cancelled job goes back to `queued` and carries on from where it stopped, on the Runner that holds its work; one paused before it started simply starts. Resuming a job that is queued or running changes nothing, and one that gives it other limits than its own is refused: its run keeps them. A job whose pause its Runner has not yet confirmed, whose cancel waits, that succeeded, that never started before it ended, or whose Batch is cancelled, is refused. A job resumed while its Batch is paused is `queued` and waits for the Batch. A resume may give a new `runTimeoutSeconds` or `modelBudgetUsd`. Each limit left out keeps the job's stored value. `GET /jobs/limits` gives the maxima for supplied values and the defaults used only at Batch creation. A resume that requeues the job is refused when its model calls have already cost its budget or more, as for a job that failed with `modelBudgetExceeded`.",
        }),
        ...byKeyOrMember({ job: ["resume"] }),
      )
      .input(
        z.extend(jobRefSchema, {
          runTimeoutSeconds: z.optional(
            runTimeoutSecondsSchema.check(
              z.describe(
                "A new `runTimeoutSeconds` for the job's next run, refused above the hub's maximum, and for a job that is queued or running unless it is the job's own.",
              ),
            ),
          ),
          modelBudgetUsd: z.optional(
            modelBudgetUsdSchema.check(
              z.describe(
                "A new `modelBudgetUsd` for the job, refused above the hub's maximum, at or below what its model calls have cost, and for a job that is queued or running unless it is the job's own.",
              ),
            ),
          ),
        }),
      )
      .output(jobSchema),
    cancel: forMembers
      .errors({ [NotFound.code]: NotFound })
      .meta(
        openapi({
          method: "POST",
          path: "/jobs/{id}/cancel",
          description:
            "Cancels a job and answers with the job. A job not yet sent to a Runner, or paused, ends `cancelled` at once. Otherwise the cancel waits for its Runner, shown as `pendingControl`, replacing a waiting pause, and the job ends `cancelled` once the Runner has stopped it, keeping its events and costs. A job that has ended, or ends before its Runner stops it, keeps the status and output it ended with.",
        }),
        ...byKeyOrMember({ job: ["cancel"] }),
      )
      .input(jobRefSchema)
      .output(jobSchema),
    // Deletion removes content and records the host file purge still owed.
    delete: forMembers
      .errors({ [NotFound.code]: NotFound, [ControlRefused.code]: ControlRefused })
      .meta(
        openapi({
          method: "DELETE",
          path: "/jobs/{id}",
          description:
            "Deletes a finished job and answers with the job as it now reads. Its content goes from the hub at once, its Input files' Blobs included unless an upload under seven days old still holds them, and from its host once its Runner has deleted its journal and Workspace; until then the job reads without its content, with `deletedAt` and a waiting `delete`, and then as not found. Its Usage record stays, and so does its Batch, with the agent's instructions and Output contract. An unfinished job is refused: cancel it first.",
        }),
        ...byKeyOrMember({ job: ["delete"] }),
      )
      .input(jobRefSchema)
      .output(jobSchema),
    events: forMembers
      .errors({ [NotFound.code]: NotFound })
      .meta(
        openapi({
          method: "GET",
          path: "/jobs/{id}/events",
          description:
            "Reads a job's events, oldest first unless `order` is desc. With `order` desc and `limit` 2 returning IDs 98 and 93, pass `after` 93 in the same order for older events, and `after` 98 in ascending order to follow new ones, or `after` 0 if the first page was empty. `hasMore` says whether more events are stored in that order. When following, read again at once while `hasMore` is true, or after a few seconds otherwise, and stop when an ascending page has a final `status` and `hasMore` is false. The Events have a 1 MiB budget. The first eligible event is always included, even if it alone exceeds the budget. Events lost with a host may be missing.",
        }),
        ...byKeyOrMember({ job: ["read"] }),
      )
      .input(
        z.extend(jobRefSchema, {
          // Let the hub apply the default so the CLI can omit this field against older hubs.
          order: z.optional(jobEventOrderSchema),
          after: z._default(
            z
              .int()
              .check(
                z.nonnegative(),
                z.describe(
                  "Continue past this Event ID in the requested order. Omit or use 0 to start at the first Event in that order.",
                ),
              ),
            0,
          ),
          limit: z._default(
            z
              .int()
              .check(
                z.minimum(1),
                z.maximum(100),
                z.describe("At most this many events in the page, 100 by default."),
              ),
            100,
          ),
        }),
      )
      .output(jobEventsPageSchema),
    list: forMembers
      .meta(
        openapi({
          method: "GET",
          path: "/jobs",
          description:
            "Lists jobs, newest first, in pages of at most `limit`. Filters combine: a job is listed when it has one of the `status` values given, every label in `labels`, the `batchId`, `customId` and `runnerId` given, and `statusUnknown` present or absent as asked. Read the next page with the same filters and `after` set to the last job's `id`, while the page says `hasMore`. A listed job has no `output`, failure `message` or `activity`: read the job for those.",
          // Repeated `status=…` parameters, a single one included, read as a list.
          queryStyles: { status: "array" },
        }),
        ...byKeyOrMember({ job: ["read"] }),
      )
      .input(
        z.strictObject({
          status: z.optional(z.array(jobStatusSchema).check(statusFilterDescription)),
          labels: labelFilterSchema,
          batchId: z.optional(
            batchIdSchema.check(z.describe("The ID of the Batch the job belongs to.")),
          ),
          customId: z.optional(
            customIdSchema.check(
              z.describe(
                "The job's own `customId`, which is unique in its Batch, so without `batchId` it may match a job in each of several Batches.",
              ),
            ),
          ),
          runnerId: z.optional(
            textSchema.check(
              z.describe(
                "The ID of the Runner the job was last sent to, which a started job keeps and shows as its `runner.id` while that Runner exists; a removed Runner's jobs still match its ID. A job not yet sent, or one its Runner paused or cancelled before starting it, matches none.",
              ),
            ),
          ),
          statusUnknown: z.optional(
            z
              .boolean()
              .check(
                z.describe(
                  "`true` for only the jobs whose status the hub cannot confirm now (`statusUnknown`), `false` for only the others; any job when absent.",
                ),
              ),
          ),
          after: z.optional(
            jobIdSchema.check(
              z.describe("The last job's ID on the previous page, to read on after it."),
            ),
          ),
          limit: z._default(
            z
              .int()
              .check(
                z.minimum(1),
                z.maximum(100),
                z.describe("At most this many jobs in the page, 50 by default."),
              ),
            50,
          ),
        }),
      )
      .output(jobsPageSchema),
    counts: forMembers
      .meta(
        openapi({
          method: "GET",
          path: "/jobs/counts",
          description:
            "Counts the Organization's queued, running and paused jobs at one moment. The queued and running totals each include the jobs of that status that show `statusUnknown`, whose counts are also returned separately. Any filter or other input is refused.",
        }),
        ...byKeyOrMember({ job: ["read"] }),
      )
      // Strict, so a stray parameter such as `batchId` is refused rather than answered with the
      // Organization's counts, which would read as the Batch's (ADR 0010).
      .input(noQueryParametersSchema)
      .output(jobCountsSchema),
    // Their own read rather than a general settings document: a submit form needs these limits before
    // it has a Batch or job, and no other deployment setting shapes what it may send. Putting them on
    // either would mix policy with stored values. Like other job reads, this takes job:read. A key needs
    // every permission a call lists, so accepting either job:create or job:resume would require a
    // different check. We can grant those keys access later.
    limits: forMembers
      .meta(
        openapi({
          method: "GET",
          path: "/jobs/limits",
          description:
            "Reads the hub's default run timeout and total model budget for each job in a new Batch, and the maximum it accepts for each limit at Batch creation or job resume.",
        }),
        ...byKeyOrMember({ job: ["read"] }),
      )
      .input(noQueryParametersSchema)
      .output(jobLimitsSchema),
  },
  usage: {
    get: forMembers
      .meta(
        openapi({
          method: "GET",
          path: "/usage",
          description: `Reads the Organization's job ends and model usage over a window of UTC days. The answer gives the total and every day's counts, oldest first, including empty days. With \`groupBy\`, it also gives up to \`limit\` groups ranked by cost over the whole window, then by tokens, then in a fixed order. The remaining groups are counted and summed in \`other\`. Only owners and admins may read it. Other members are refused with 403. Each job end counts on the day the hub recorded it. A job resumed after it ended counts once for each end, with what it used since its previous end. Deleted jobs still count. A Batch's own \`usage\` counts its jobs not deleted, unfinished ones included, while this counts ended work, deleted jobs included, so the two can differ. Filters combine as when listing jobs: a job's end counts when the job ended in one of the \`status\` values given, with every label in \`labels\`, and has the \`batchId\`, \`submitter\` and \`runnerId\` given. A window whose \`from\` is after its \`to\`, that is longer than ${MAX_USAGE_DAYS} days or that starts before 0001-01-01 is refused.`,
          // Repeated `status=…` parameters, a single one included, read as a list.
          queryStyles: { status: "array" },
        }),
        ...byMember,
      )
      .input(
        z.strictObject({
          period: z.optional(
            usagePeriodSchema.check(
              z.describe(
                `1d through ${MAX_USAGE_DAYS}d for that many UTC days ending today, or YYYY-MM (years 0001–9999) for that month through today. With from or to, or for a month that has not begun, the hub refuses period with 400. With no period or dates, the window is the last 30 days.`,
              ),
            ),
          ),
          from: z.optional(
            dateSchema.check(
              z.describe(
                "The window's first day, as `YYYY-MM-DD`, a UTC day. A start after today is refused with 400 naming `from`. Defaults to 29 days before the effective `to`.",
              ),
            ),
          ),
          to: z.optional(
            dateSchema.check(
              z.describe(
                "The window's last day, included, as `YYYY-MM-DD`, a UTC day. Defaults to today and is capped at today.",
              ),
            ),
          ),
          groupBy: z.optional(
            usageGroupBySchema.check(
              z.describe(
                "What to group usage by: `batch`, `submitter` for who submitted the jobs, an API key or a member, named as the group's latest record in the window names it, the one recorded last, `runner` for the Runner they last ran on, `status` for the status they ended in, or `label:` and a label's key, such as `label:customer`, for that label's value. Not grouped when absent.",
              ),
            ),
          ),
          limit: z._default(
            z
              .int()
              .check(
                z.minimum(1),
                z.maximum(50),
                z.describe(
                  "With `groupBy`, at most this many groups, 10 by default; the rest are summed as `other`.",
                ),
              ),
            10,
          ),
          batchId: z.optional(
            batchIdSchema.check(z.describe("The ID of the Batch the jobs belong to.")),
          ),
          submitter: z.optional(
            z
              .strictObject({
                kind: z.enum([KEY_SUBMITTER, MEMBER_SUBMITTER]),
                id: textSchema.check(z.minLength(1)),
              })
              .check(
                z.describe(
                  "Who submitted the jobs, as the `submitter` group names them: its `kind`, `key` for an API key or `member` for a member, and its `id`.",
                ),
              ),
          ),
          runnerId: z.optional(
            textSchema.check(z.describe("The ID of the Runner the jobs last ran on.")),
          ),
          status: z.optional(z.array(finalJobStatusSchema).check(statusFilterDescription)),
          labels: labelFilterSchema,
        }),
      )
      .output(usageReportSchema),
  },
});
