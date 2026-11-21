import {
  batchCreationSchema,
  filePathSchema,
  fileSizeBytesSchema,
  type JobLimits,
  MAX_BODY_BYTES,
  MAX_FILE_BYTES,
  MAX_JOBS_PER_REQUEST,
  uniqueCustomIds,
} from "contract";
import { BigDecimal } from "effect";
import * as z from "zod/mini";

/** A job typed on the page: its Custom ID and its input. */
export interface TypedJob {
  readonly kind: "typed";
  readonly customId: string;
  readonly input: string;
}

/**
 * A job made of one file the member chose: the file is its one Input file, under its own name, and
 * the job has no input of its own, so the agent works on the file as its instructions say.
 */
export interface FileJob {
  readonly kind: "file";
  readonly customId: string;
  readonly file: File;
}

/** A job of the Batch being gathered, in the order the page lists it. */
export type DraftJob = TypedJob | FileJob;

/** A Batch creation as the page sends it. */
export type Creation = z.input<typeof batchCreationSchema>;

/**
 * The agent of a draft: its Output schema parsed, or, while its text is not JSON, the text as typed,
 * which is what a request would carry.
 */
export type DraftAgent = Omit<Creation["agent"], "outputContract"> & {
  readonly outputContract: { readonly schema: unknown };
};

/**
 * A Batch being gathered: the creation's fields as they will be sent, and its jobs as rows, whose
 * files are named by digest only once they are read.
 */
export type BatchDraft = Omit<Creation, "jobs" | "agent"> & {
  readonly agent: DraftAgent;
  readonly jobs: readonly DraftJob[];
};

/** The creation a draft sends, which the contract's check decides is one. */
export type DraftCreation = Omit<BatchDraft, "jobs"> & { readonly jobs: Creation["jobs"] };

/**
 * A new typed job, its Custom ID `job-N` with the first number from 1 that no job of `jobs` has,
 * so a new row never starts as a repeat.
 */
export function typedJob(jobs: readonly DraftJob[]): TypedJob {
  const taken = new Set(jobs.map(({ customId }) => customId));
  let number = 1;
  while (taken.has(`job-${number}`)) number += 1;
  return { kind: "typed", customId: `job-${number}`, input: "" };
}

/**
 * A job for each of `files`, its Custom ID the file's name, unchanged: a Custom ID takes any text a
 * file name can be, and two files with one name both keep it, as the repeat is told at each.
 */
export function fileJobs(files: Iterable<File>): FileJob[] {
  return Array.from(files, (file) => ({ kind: "file", customId: file.name, file }));
}

/**
 * Why the hub would refuse `file` as an Input file, known without reading it: its name as a path,
 * and its size, each in the contract's words. Empty when neither is refused.
 */
export function fileProblems(file: File): string[] {
  const checks = [
    z.safeParse(filePathSchema, file.name),
    z.safeParse(fileSizeBytesSchema, file.size),
  ];
  return checks.flatMap((checked) =>
    checked.success ? [] : checked.error.issues.map(({ message }) => message),
  );
}

const customIdsSchema = z.array(z.object({ customId: z.string() })).check(uniqueCustomIds);

/**
 * The jobs of `jobs` whose Custom ID another job has, by their index, each with the contract's words
 * for it, which name the ID and no row. Every use is told, the first one too.
 */
export function repeatedCustomIds(jobs: readonly DraftJob[]): Map<number, string> {
  const checked = z.safeParse(
    customIdsSchema,
    jobs.map(({ customId }) => ({ customId })),
  );
  const repeated = new Map<number, string>();
  for (const { path, message } of checked.success ? [] : checked.error.issues) {
    const [index] = path;
    if (typeof index === "number") repeated.set(index, message);
  }
  return repeated;
}

/**
 * The indexes of the jobs of `jobs` that are refused before anything is read: a file the hub would
 * refuse, or a Custom ID another job has. A Batch with any of them is not sent.
 */
export function jobsRefusedAtAdd(jobs: readonly DraftJob[]): number[] {
  const repeated = repeatedCustomIds(jobs);
  return jobs.flatMap((job, index) =>
    repeated.has(index) || (job.kind === "file" && fileProblems(job.file).length > 0)
      ? [index]
      : [],
  );
}

/** A digest's form, for the size of a request whose files are not read yet: all have one length. */
const UNREAD_DIGEST = `sha256:${"0".repeat(64)}`;

/** The creation `draft` sends, each file named by its digest in `digests`. */
export function creationOf(draft: BatchDraft, digests: ReadonlyMap<File, string>): DraftCreation {
  return {
    ...draft,
    jobs: draft.jobs.map((job) =>
      job.kind === "typed"
        ? { customId: job.customId, input: job.input }
        : {
            customId: job.customId,
            files: [
              {
                path: job.file.name,
                digest: digests.get(job.file) ?? UNREAD_DIGEST,
                sizeBytes: job.file.size,
              },
            ],
          },
    ),
  };
}

/** The bytes `creation` takes as the request's body, which the hub reads whole. */
export function requestBytes(creation: DraftCreation): number {
  return new TextEncoder().encode(JSON.stringify(creation)).length;
}

/** What a Batch draft holds against what one request takes, as the page states before Submit. */
export interface DraftFacts {
  readonly jobs: {
    readonly count: number;
    readonly fromFiles: number;
    readonly typed: number;
    readonly max: number;
  };
  /** The request's body, the files named by digest and the rest as typed. */
  readonly request: { readonly bytes: number; readonly max: number };
  /** The files, each counted once, and how many are over the most one may hold. */
  readonly files: {
    readonly count: number;
    readonly bytes: number;
    readonly maxEach: number;
    readonly overMax: number;
  };
  /**
   * What the jobs' model budgets add up to: each job's, as set or the hub's default, times the jobs.
   * Unknown while the hub's limits are not read and no budget is set.
   */
  readonly budgets:
    | { readonly from: "set" | "default"; readonly eachUsd: number; readonly totalUsd: number }
    | { readonly from: "unknown" };
}

/**
 * The facts of `draft`, with the hub's limits `limits` when they are read: its jobs, its request's
 * size and its files, each beside the most one request or one file takes, and what its model budgets
 * add up to. The page's arithmetic on the contract's limits; the hub decides.
 */
export function draftFacts(draft: BatchDraft, limits: JobLimits | undefined): DraftFacts {
  const count = draft.jobs.length;
  const files = [...new Set(draft.jobs.flatMap((job) => (job.kind === "file" ? [job.file] : [])))];
  const set = draft.agent.modelBudgetUsd;
  const eachUsd = set ?? limits?.modelBudgetUsd.default;
  return {
    jobs: {
      count,
      fromFiles: draft.jobs.filter((job) => job.kind === "file").length,
      typed: draft.jobs.filter((job) => job.kind === "typed").length,
      max: MAX_JOBS_PER_REQUEST,
    },
    request: { bytes: requestBytes(creationOf(draft, new Map())), max: MAX_BODY_BYTES },
    files: {
      count: files.length,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
      maxEach: MAX_FILE_BYTES,
      overMax: files.filter((file) => file.size > MAX_FILE_BYTES).length,
    },
    budgets:
      eachUsd === undefined
        ? { from: "unknown" }
        : {
            from: set === undefined ? "default" : "set",
            eachUsd,
            // In decimal, so 0.1 USD for 3 jobs adds up to 0.3 USD.
            totalUsd: BigDecimal.toNumberUnsafe(
              BigDecimal.multiply(
                BigDecimal.fromNumberUnsafe(eachUsd),
                BigDecimal.fromNumberUnsafe(count),
              ),
            ),
          },
  };
}
