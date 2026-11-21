import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  asError,
  batchCreationSchema,
  type CreatedBatch,
  MAX_BODY_BYTES,
  MAX_FILES_PER_CHECK,
  SUGGESTED_AT_ONCE,
} from "contract";
import { Array, Context, Effect, Queue, Result, Stream } from "effect";
import * as z from "zod/mini";

import { api, hubFailureMessage } from "./api-client.ts";
import {
  type BatchDraft,
  type Creation,
  creationOf,
  type DraftJob,
  draftFiles,
  requestBytes,
} from "./batch-draft.ts";

/** How far the uploads are, once the hub has said which contents it holds. */
export interface UploadFigures {
  readonly uploaded: number;
  readonly uploadedBytes: number;
  /** The contents to upload, each once, and their bytes. */
  readonly files: number;
  readonly bytes: number;
  /** The files whose content the hub already holds, which are not uploaded. */
  readonly held: number;
  /** The files whose content another file being uploaded has, which is uploaded once. */
  readonly same: number;
}

/**
 * How far a send is, for the page to show the step and its figures: reading the files, asking the hub which contents it holds and uploading the others (`uploading`, its
 * figures once the hub has answered), then creating the Batch.
 */
export type SendProgress =
  | { readonly step: "reading"; readonly read: number; readonly files: number }
  | { readonly step: "uploading"; readonly figures?: UploadFigures }
  | { readonly step: "creating" };

/** A job, by its index in the draft, and why it stopped the send. */
export interface JobProblem {
  readonly index: number;
  readonly message: string;
}

/**
 * How a send ended. Each end but `created` and `createFailed` created no Batch, though files it
 * uploaded stay in the hub, where the next try finds them.
 */
export type SendOutcome =
  /** The hub created the Batch, or answered a repeat of the same request with it. */
  | { readonly kind: "created"; readonly answer: CreatedBatch }
  /** Stopped before the create was sent. */
  | { readonly kind: "stopped" }
  /** Files the browser could not read, each with the browser's reason, after the others were read. */
  | { readonly kind: "unreadable"; readonly jobs: readonly JobProblem[] }
  /**
   * The request as the contract refuses it, before anything is read, its issues placed as the hub's
   * are, by path: among them a Custom ID given twice and a file the hub would refuse by its name or
   * size, which each row also tells when it is added.
   */
  | { readonly kind: "invalid"; readonly issues: readonly z.core.$ZodIssue[] }
  /** The request's body is over the most one request takes. */
  | { readonly kind: "tooLarge" }
  /** The hub's check of which files it holds failed. */
  | { readonly kind: "checkFailed"; readonly error: unknown }
  /**
   * Uploads that failed, each with the hub's words at every job whose file holds that content, after
   * the others finished.
   */
  | { readonly kind: "notUploaded"; readonly jobs: readonly JobProblem[] }
  /** The create failed or got no answer: the hub's error, to place as its refusals are. */
  | { readonly kind: "createFailed"; readonly error: unknown };

/**
 * The digest the hub names `file`'s content by: `sha256:` and its SHA-256 in hex. Not Web Crypto's
 * `digest`: it hashes one buffer, so a 100 MiB file would be held in memory whole, and
 * `crypto.subtle` is undefined outside a secure context, where the dashboard may be served
 * (docs/deploy.md, "A private network").
 */
const digestOf = (file: File) =>
  Stream.fromReadableStream({ evaluate: () => file.stream(), onError: asError }).pipe(
    Stream.runFold(
      () => sha256.create(),
      (hash, chunk) => hash.update(chunk),
    ),
    Effect.map((hash) => `sha256:${bytesToHex(hash.digest())}`),
  );

/** Each job of `jobs` whose file `messageOf` gives a message for, with it, by the job's index. */
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
 * Everything before the create of `draft`, which the contract takes, with `files` its files: reads
 * every file, asks the hub which contents it holds and uploads the others. Answers the request to
 * send, or how it stopped.
 */
const prepare = Effect.fnUntraced(function* (
  draft: BatchDraft,
  files: readonly File[],
  onProgress: (progress: SendProgress) => void,
) {
  let read: readonly { readonly file: File; readonly digest: string }[] = [];
  if (files.length > 0) {
    let count = 0;
    onProgress({ step: "reading", read: count, files: files.length });
    const [passes, unreadable] = yield* Effect.partition(
      files,
      (file) =>
        digestOf(file).pipe(
          Effect.map((digest) => ({ file, digest })),
          Effect.mapError((error) => ({ file, reason: error.message })),
          Effect.ensuring(
            Effect.sync(() => {
              count += 1;
              onProgress({ step: "reading", read: count, files: files.length });
            }),
          ),
        ),
      { concurrency: SUGGESTED_AT_ONCE },
    );
    if (unreadable.length > 0) {
      const reasons = new Map(unreadable.map(({ file, reason }) => [file, reason]));
      return {
        kind: "unreadable",
        jobs: jobProblems(draft.jobs, (file) => reasons.get(file)),
      } as const;
    }
    read = passes;
  }

  const digests = new Map(read.map(({ file, digest }) => [file, digest]));
  // Sent as built, not as the contract's check gives it with its defaults, so the request is the one
  // whose size the page stated.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the contract took the unread request, and a read digest has an unread one's form
  const creation = creationOf(draft, digests) as Creation;
  if (files.length === 0) return { kind: "ready", creation } as const;

  onProgress({ step: "uploading" });

  // Each content once, however many files hold it.
  const contents = Array.dedupeWith(
    read.map(({ file, digest }) => ({ file, digest, sizeBytes: file.size })),
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
  const missingDigests = new Set(missing.map(({ digest }) => digest));
  // In files throughout, so the three figures add up to the files read.
  const filesMissing = read.filter(({ digest }) => missingDigests.has(digest)).length;
  const toUpload = {
    files: missing.length,
    bytes: missing.reduce((sum, { sizeBytes }) => sum + sizeBytes, 0),
    held: files.length - filesMissing,
    same: filesMissing - missing.length,
  };
  let uploaded = 0;
  let uploadedBytes = 0;
  if (missing.length > 0)
    onProgress({ step: "uploading", figures: { uploaded, uploadedBytes, ...toUpload } });
  // Every upload runs, one failing or not, so one try tells about every file.
  const [, failed] = yield* Effect.partition(
    missing,
    ({ file, digest, sizeBytes }) =>
      Effect.tryPromise({
        // A `File` body: the browser reads it as it sends and gives its `Content-Length`.
        try: (signal) =>
          api.blobs.upload(
            { params: { digest }, headers: { "content-length": sizeBytes }, body: file },
            { signal },
          ),
        catch: (error) => ({ digest, message: hubFailureMessage(error) }),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            uploaded += 1;
            uploadedBytes += sizeBytes;
            onProgress({ step: "uploading", figures: { uploaded, uploadedBytes, ...toUpload } });
          }),
        ),
      ),
    { concurrency: SUGGESTED_AT_ONCE },
  );
  if (failed.length > 0) {
    const messages = new Map(failed.map(({ digest, message }) => [digest, message]));
    return {
      kind: "notUploaded",
      jobs: jobProblems(draft.jobs, (file) => {
        const digest = digests.get(file);
        return digest === undefined ? undefined : messages.get(digest);
      }),
    } as const;
  }
  return { kind: "ready", creation } as const;
});

/** How the steps before the create ended: the creation ready to send, or how they stopped. */
export type Prepared =
  | Exclude<SendOutcome, { readonly kind: "created" | "createFailed" }>
  | { readonly kind: "ready"; readonly creation: Creation };

/** A report of how far the steps before the create are, or how they ended. */
type PrepareStep = { readonly progress: SendProgress } | { readonly prepared: Prepared };

/**
 * Everything before `draft`'s create, which the hub commits whole or not at all: checks the request
 * as the contract does, reads every file and names it by its digest, and uploads each content the
 * hub does not hold. Yields how far it is as it goes, and returns how it stopped or the creation ready
 * to send. `signal` stops it. Nothing is tried again by itself.
 */
export async function* prepareBatch(
  draft: BatchDraft,
  signal: AbortSignal,
): AsyncGenerator<SendProgress, Prepared, void> {
  // The request's count, form and size do not depend on what the files hold, as an unread file's
  // digest has a read one's length: what the contract refuses is told before anything is read.
  const unread = creationOf(draft, new Map());
  const early = z.safeParse(batchCreationSchema, unread);
  if (!early.success) return { kind: "invalid", issues: early.error.issues };
  if (requestBytes(unread) > MAX_BODY_BYTES) return { kind: "tooLarge" };

  // Every file is read each time, so a file changed since the last try is named by what it holds.
  // A row holds its own `File`, so files are told apart by identity: two alike in name, size and
  // time may differ in what they hold.
  const files = draftFiles(draft.jobs);
  // The program's reports, then its outcome, read one at a time. Every failure the hub or a file can
  // cause is an outcome, so a stream that fails is a mistake in the page, and its read throws.
  const steps = Stream.callback<PrepareStep>((queue) =>
    prepare(draft, files, (progress) => Queue.offerUnsafe(queue, { progress })).pipe(
      Effect.flatMap((prepared) => Queue.offer(queue, { prepared })),
      Effect.andThen(Queue.end(queue)),
    ),
  );
  // Not `Stream.toReadableStream`, whose types take no signal.
  const reader = Stream.toReadableStreamWith(steps, Context.empty(), { signal }).getReader();
  try {
    for (let step = await reader.read(); !step.done; step = await reader.read()) {
      if ("prepared" in step.value) return step.value.prepared;
      yield step.value.progress;
    }
    // `signal` closed the stream before its outcome.
    return { kind: "stopped" };
  } finally {
    // A caller that stops reading early stops the program too.
    void reader.cancel();
  }
}

/** Creates the Batch `creation` describes, which cannot be recalled once sent. */
export async function createBatch(
  creation: Creation,
): Promise<Extract<SendOutcome, { readonly kind: "created" | "createFailed" }>> {
  try {
    return { kind: "created", answer: await api.batches.create(creation) };
  } catch (error) {
    return { kind: "createFailed", error };
  }
}
