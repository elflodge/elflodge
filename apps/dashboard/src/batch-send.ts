import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  asError,
  batchCreationSchema,
  type CreatedBatch,
  MAX_BODY_BYTES,
  MAX_FILES_PER_CHECK,
} from "contract";
import { Array, Cause, Effect, Exit, Result, Stream } from "effect";
import * as z from "zod/mini";

import { api, hubFailureMessage } from "./api-client.ts";
import {
  type BatchDraft,
  creationOf,
  type DraftJob,
  jobsRefusedAtAdd,
  requestBytes,
} from "./batch-draft.ts";

/**
 * How many files are read, and how many uploaded, at once: five, as the CLI's `batches submit` does
 * for the same reason. Each upload holds one of the hub's database connections while it writes.
 */
const AT_ONCE = 5;

/** How far a send is, for the page to show the step and its figures. */
export type SendProgress =
  | { readonly step: "reading"; readonly read: number; readonly files: number }
  | {
      readonly step: "uploading";
      readonly uploaded: number;
      readonly uploadedBytes: number;
      readonly files: number;
      readonly bytes: number;
      /** The files the hub already holds, which are not uploaded. */
      readonly held: number;
    }
  | { readonly step: "creating" };

/** A job, by its index in the draft, and why it stopped the send. */
export interface JobProblem {
  readonly index: number;
  readonly message: string;
}

/** How a send ended. Each end but `created` and `createFailed` made nothing in the hub. */
export type SendOutcome =
  /** The hub created the Batch, or answered a repeat of the same request with it. */
  | { readonly kind: "created"; readonly answer: CreatedBatch }
  /** Stopped before the create was sent. */
  | { readonly kind: "stopped" }
  /** Jobs refused when they were added: a file the hub would refuse, or a Custom ID given twice. */
  | { readonly kind: "refusedAtAdd"; readonly indexes: readonly number[] }
  /** Files the browser could not read, each with the browser's reason, after the others were read. */
  | { readonly kind: "unreadable"; readonly jobs: readonly JobProblem[]; readonly files: number }
  /** The request as the contract refuses it, its issues placed as the hub's are, by path. */
  | { readonly kind: "invalid"; readonly issues: readonly z.core.$ZodIssue[] }
  /** The request's body is over the most one request takes. */
  | { readonly kind: "tooLarge"; readonly bytes: number; readonly max: number }
  /** The hub's check of which files it holds failed. */
  | { readonly kind: "checkFailed"; readonly error: unknown }
  /** Uploads that failed, each with the hub's words, after the others finished. */
  | {
      readonly kind: "notUploaded";
      readonly jobs: readonly JobProblem[];
      readonly failed: number;
      readonly files: number;
    }
  /** The create failed or got no answer: the hub's error, to place as its refusals are. */
  | { readonly kind: "createFailed"; readonly error: unknown };

/** The digest the hub names `file`'s content by: `sha256:` and its SHA-256 in hex. */
const digestOf = (file: File) =>
  Stream.fromReadableStream({ evaluate: () => file.stream(), onError: asError }).pipe(
    Stream.runFold(
      () => sha256.create(),
      (hash, chunk) => hash.update(chunk),
    ),
    Effect.map((hash) => `sha256:${bytesToHex(hash.digest())}`),
  );

/** Each job of `jobs` whose file has a message in `messages`, with it, by the job's index. */
function jobProblems(
  jobs: readonly DraftJob[],
  messageOf: (file: File) => string | undefined,
): JobProblem[] {
  return jobs.flatMap((job, index) => {
    const message = job.kind === "file" ? messageOf(job.file) : undefined;
    return message === undefined ? [] : [{ index, message }];
  });
}

/**
 * Everything before the create: reads every file, checks the request, asks the hub which contents
 * it holds and uploads the others. Answers the request to send, or how it stopped.
 */
const prepare = Effect.fnUntraced(function* (
  draft: BatchDraft,
  onProgress: (progress: SendProgress) => void,
) {
  const refused = jobsRefusedAtAdd(draft.jobs);
  if (refused.length > 0) return { kind: "refusedAtAdd", indexes: refused } as const;

  // Every file is read each time, so a file changed since the last try is named by what it holds.
  const files = Array.dedupe(draft.jobs.flatMap((job) => (job.kind === "file" ? [job.file] : [])));
  let read = 0;
  onProgress({ step: "reading", read, files: files.length });
  const readings = yield* Effect.forEach(
    files,
    (file) =>
      digestOf(file).pipe(
        Effect.result,
        Effect.tap(() =>
          Effect.sync(() => {
            read += 1;
            onProgress({ step: "reading", read, files: files.length });
          }),
        ),
      ),
    { concurrency: AT_ONCE },
  );
  const unread = Array.zip(files, readings).flatMap(([file, reading]) =>
    Result.isFailure(reading) ? [{ file, reason: reading.failure.message }] : [],
  );
  if (unread.length > 0) {
    const reasons = new Map(unread.map(({ file, reason }) => [file, reason]));
    return {
      kind: "unreadable",
      jobs: jobProblems(draft.jobs, (file) => reasons.get(file)),
      files: files.length,
    } as const;
  }
  const digests = new Map(
    Array.zip(files, readings).flatMap(([file, reading]) =>
      Result.isSuccess(reading) ? [[file, reading.success] as const] : [],
    ),
  );

  const creation = creationOf(draft, digests);
  const checked = z.safeParse(batchCreationSchema, creation);
  if (!checked.success) return { kind: "invalid", issues: checked.error.issues } as const;
  const bytes = requestBytes(creation);
  if (bytes > MAX_BODY_BYTES) return { kind: "tooLarge", bytes, max: MAX_BODY_BYTES } as const;

  // Each content once, however many files hold it.
  const contents = Array.dedupeWith(
    files.map((file) => ({ file, digest: digests.get(file) ?? "", sizeBytes: file.size })),
    (a, b) => a.digest === b.digest,
  );
  const answers = yield* Effect.forEach(Array.chunksOf(contents, MAX_FILES_PER_CHECK), (chunk) =>
    Effect.tryPromise({
      try: (signal) =>
        api.blobs.check(
          { files: chunk.map(({ digest, sizeBytes }) => ({ digest, sizeBytes })) },
          { signal },
        ),
      catch: (error) => error,
    }).pipe(
      // The check answers its files in the order given.
      Effect.map(({ files: held }) => Array.zip(chunk, held)),
    ),
  ).pipe(Effect.result);
  if (Result.isFailure(answers)) return { kind: "checkFailed", error: answers.failure } as const;
  const missing = answers.success
    .flat()
    .flatMap(([content, held]) => (held.stored ? [] : [content]));
  const toUpload = {
    files: missing.length,
    bytes: missing.reduce((sum, { sizeBytes }) => sum + sizeBytes, 0),
    held: contents.length - missing.length,
  };
  let uploaded = 0;
  let uploadedBytes = 0;
  onProgress({ step: "uploading", uploaded, uploadedBytes, ...toUpload });
  const uploads = yield* Effect.forEach(
    missing,
    ({ file, digest, sizeBytes }) =>
      Effect.tryPromise({
        // A `File` body: the browser reads it as it sends and gives its `Content-Length`.
        try: (signal) =>
          api.blobs.upload(
            { params: { digest }, headers: { "content-length": sizeBytes }, body: file },
            { signal },
          ),
        catch: (error) => error,
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            uploaded += 1;
            uploadedBytes += sizeBytes;
            onProgress({ step: "uploading", uploaded, uploadedBytes, ...toUpload });
          }),
        ),
        // One upload failing lets the others finish, so one try tells about every file.
        Effect.result,
      ),
    { concurrency: AT_ONCE },
  );
  const failed = Array.zip(missing, uploads).flatMap(([{ digest }, upload]) =>
    Result.isFailure(upload) ? [{ digest, message: hubFailureMessage(upload.failure) }] : [],
  );
  if (failed.length > 0) {
    const messages = new Map(failed.map(({ digest, message }) => [digest, message]));
    return {
      kind: "notUploaded",
      jobs: jobProblems(draft.jobs, (file) => messages.get(digests.get(file) ?? "")),
      failed: failed.length,
      files: missing.length,
    } as const;
  }
  return { kind: "ready", creation } as const;
});

/**
 * Sends `draft` as one Batch creation, which the hub commits whole or not at all: reads every file
 * and names it by its digest, checks the request as the contract does, uploads each content the hub
 * does not hold, then creates the Batch. Reports how far it is with `onProgress`. `signal` stops it
 * until the create is sent, which cannot be recalled. Nothing is tried again by itself.
 */
export async function sendBatch(
  draft: BatchDraft,
  options: { readonly signal: AbortSignal; readonly onProgress: (progress: SendProgress) => void },
): Promise<SendOutcome> {
  const { signal, onProgress } = options;
  const prepared = await Effect.runPromiseExit(prepare(draft, onProgress), { signal });
  if (Exit.isFailure(prepared)) {
    if (Exit.hasInterrupts(prepared)) return { kind: "stopped" };
    // Every failure the hub or a file can cause is an outcome, so this is a mistake in the page.
    throw Cause.squash(prepared.cause);
  }
  const outcome = prepared.value;
  if (outcome.kind !== "ready") return outcome;
  if (signal.aborted) return { kind: "stopped" };
  onProgress({ step: "creating" });
  try {
    return { kind: "created", answer: await api.batches.create(outcome.creation) };
  } catch (error) {
    return { kind: "createFailed", error };
  }
}
