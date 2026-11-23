import type { JSX } from "@solidjs/web";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  createConfirm,
  type AlertDialogController,
} from "@ui-sdk/solid/alert-dialog";
import { Button } from "@ui-sdk/solid/button";
import { For, Show, createSignal, flush } from "solid-js";

import { type DraftJob, fileJobs, typedJob } from "../batch-draft.ts";
import { focusNextRemove } from "../form.ts";
import { formatBytes } from "../format-bytes.ts";
import { formatCount, plural } from "../format.ts";
import { FieldGroup } from "./Field.tsx";
import { FieldError } from "./FieldError.tsx";

/**
 * A job of the draft as the page lists it: what the form cannot say. `key` names its row for as long
 * as it is listed. What is typed in its fields lives in the form alone, which `jobsOf` reads.
 */
export type DraftRow = {
  readonly key: number;
  /** The Custom ID it was added with, its field's starting value. */
  readonly customId: string;
  /** Why the hub would refuse its file, known when it was added. */
  readonly problems: readonly string[];
} & ({ readonly kind: "typed" } | { readonly kind: "file"; readonly file: File });

/**
 * The jobs of `rows` as `data`, a snapshot of the form, holds them, each row's fields read by its
 * place in the list.
 */
export function jobsOf(data: FormData, rows: readonly DraftRow[]): DraftJob[] {
  // FormData's `get` looks through every entry, so a thousand rows are read from one index.
  const values = new Map(data);
  const text = (name: string) => {
    const value = values.get(name);
    return typeof value === "string" ? value : "";
  };
  return rows.map((row, at) => {
    const customId = text(`jobs[${at}][customId]`);
    return row.kind === "file"
      ? { kind: "file", customId, file: row.file }
      : { kind: "typed", customId, input: text(`jobs[${at}][input]`) };
  });
}

/** The distinct lines of `words`, joined, or undefined for none: one problem told twice shows once. */
function wordsOf(...words: readonly (string | undefined)[]) {
  const lines = new Set(words.flatMap((part) => part?.split("\n") ?? []));
  return [...lines].join("\n") || undefined;
}

/** Whether what is dragged holds files, rather than text or a link. */
function holdsFiles(event: DragEvent) {
  return event.dataTransfer?.types.includes("Files") ?? false;
}

/** Why a send stopped at a row, at the part of it concerned. */
export interface RowRefusal {
  readonly customId?: string;
  readonly input?: string;
  readonly file?: string;
}

/**
 * The ID of the control of the row `key` that carries the words for `part`, which a link to the
 * row leads to: the Custom ID field, the Input or the file's cell.
 */
export function rowControlId(key: number, part: keyof RowRefusal = "customId") {
  return `draft-job-${key}-${part === "customId" ? "id" : part}`;
}

/**
 * The Jobs of a Batch draft: Add files (the chooser, or files dropped on the group), Add a job,
 * Remove all, then a draft Records table of every job, each with its Custom ID, its typed input or
 * its file, and Remove. What a row cannot send is told at it.
 */
export function DraftJobs(props: {
  rows: readonly DraftRow[];
  /** The jobs as the form last gave them, so a new typed job takes a Custom ID none has. */
  jobs: readonly DraftJob[];
  /** Custom IDs another row has, by row, in the contract's words. */
  repeated: ReadonlyMap<number, string>;
  refusals: ReadonlyMap<number, RowRefusal>;
  /** A refusal of the jobs as a whole. */
  error?: string;
  pending: boolean;
  /** The ID of what follows the list, where its skip link leads. */
  after: string;
  /** The hint's words. */
  hint: JSX.Element;
  onAdd: (jobs: DraftJob[]) => void;
  /** Takes out the row `key`, or every row. */
  onRemove: (key: "all" | number) => void;
  /** A row's field `part` is being edited, which ends a refusal there. */
  onEdited: (key: number, part: "customId" | "input") => void;
  /** A send got no answer, so the hub may have a Batch with these jobs, which Remove all says. */
  mayHaveBatch: boolean;
}) {
  const [said, setSaid] = createSignal("");
  const confirmRemoveAll = createConfirm<undefined>();
  const [receiving, setReceiving] = createSignal(false);
  let chooser: HTMLInputElement | undefined;
  let addFilesButton: HTMLButtonElement | undefined;
  let addJobButton: HTMLButtonElement | undefined;
  let removeAllButton: HTMLButtonElement | undefined;

  function add(jobs: DraftJob[], words: (first: number, last: number) => string) {
    if (props.pending || !jobs.length) return;
    const first = props.rows.length + 1;
    props.onAdd(jobs);
    flush();
    const added = props.rows.slice(first - 1);
    const refused = added.filter((row) => row.problems.length || props.repeated.has(row.key));
    setSaid(
      [
        words(first, first + jobs.length - 1),
        refused.length &&
          `${formatCount(refused.length)} ${plural(refused.length, "cannot be sent: it says why at its row.", "cannot be sent: each says why at its row.")}`,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  function addFiles(files: FileList | null) {
    const jobs = fileJobs(files ?? []);
    add(jobs, (first, last) =>
      jobs.length === 1
        ? `1 file added as job ${formatCount(first)}.`
        : `${formatCount(jobs.length)} files added as jobs ${formatCount(first)} to ${formatCount(last)}.`,
    );
  }
  function addTyped() {
    const job = typedJob(props.jobs);
    add([job], (first) => `Job ${formatCount(first)} added.`);
    const added = props.rows.at(-1);
    if (added) document.getElementById(rowControlId(added.key, "input"))?.focus();
  }
  function remove(row: DraftRow, number: number, button: HTMLElement) {
    focusNextRemove(button, addJobButton);
    props.onRemove(row.key);
    setSaid(`Job ${formatCount(number)} removed.`);
  }
  async function removeAll() {
    if (!(await confirmRemoveAll())) return;
    // Answered once the dialog has closed and returned focus to Remove all, so focus can move on from
    // it, as it goes with the rows.
    const count = props.rows.length;
    props.onRemove("all");
    setSaid(plural(count, "Job 1 removed.", `All ${formatCount(count)} jobs removed.`));
    flush();
    addFilesButton?.focus();
  }

  return (
    <>
      <FieldGroup
        label="Jobs"
        hint={props.hint}
        error={props.error}
        class={{ "is-receiving": receiving() }}
        onDragEnter={(event) => {
          if (!holdsFiles(event)) return;
          event.preventDefault();
          setReceiving(!props.pending);
        }}
        onDragOver={(event) => {
          if (!holdsFiles(event) || !event.dataTransfer) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = props.pending ? "none" : "copy";
        }}
        // Moving between the group's own elements fires dragleave too.
        onDragLeave={(event) => {
          if (
            !(
              event.relatedTarget instanceof Node &&
              event.currentTarget.contains(event.relatedTarget)
            )
          )
            setReceiving(false);
        }}
        onDrop={(event) => {
          if (!holdsFiles(event)) return;
          event.preventDefault();
          setReceiving(false);
          addFiles(event.dataTransfer?.files ?? null);
        }}
      >
        <div class="controls">
          <input
            type="file"
            multiple
            hidden
            ref={(element) => {
              chooser = element;
            }}
            onChange={(event) => {
              addFiles(event.currentTarget.files);
              // Choosing the same files again adds them again.
              event.currentTarget.value = "";
            }}
          />
          <Button
            ref={(element) => {
              addFilesButton = element;
            }}
            disabled={props.pending}
            focusableWhenDisabled
            onClick={() => chooser?.click()}
          >
            Add files
          </Button>
          <Button
            ref={(element) => {
              addJobButton = element;
            }}
            disabled={props.pending}
            focusableWhenDisabled
            onClick={addTyped}
          >
            Add a job
          </Button>
          <Show when={props.rows.length}>
            <Button
              ref={(element) => {
                removeAllButton = element;
              }}
              disabled={props.pending}
              focusableWhenDisabled
              onClick={() => void removeAll()}
            >
              Remove all
            </Button>
          </Show>
        </div>
        <Show when={receiving()}>
          <p class="note drop-note">Drop the files to add a job for each.</p>
        </Show>
        <Show when={!props.rows.length && !receiving()}>
          <p class="note">No jobs yet. Files can also be dropped here.</p>
        </Show>
        <Show when={props.rows.length}>
          <a class="vh skip-list" href={`#${props.after}`}>
            Skip the jobs
          </a>
          <table class="records is-draft" role="table">
            <caption class="vh">The Batch’s jobs</caption>
            <thead role="rowgroup">
              <tr role="row">
                <th scope="col" role="columnheader" class="num">
                  Job
                </th>
                <th scope="col" role="columnheader" class="is-id">
                  Custom ID
                </th>
                <th scope="col" role="columnheader">
                  Input or file
                </th>
                <th scope="col" role="columnheader" class="is-act">
                  <span class="vh">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              <For each={props.rows} keyed={(row) => row.key}>
                {(row, index) => {
                  // Read once: the fields hold what the member types, which the rows follow.
                  const first = row();
                  const id = `draft-job-${first.key}`;
                  const number = () => index() + 1;
                  // What the row tells since it was added, and the last send's refusals, which
                  // the page's own check can repeat.
                  const idError = () =>
                    wordsOf(props.repeated.get(first.key), props.refusals.get(first.key)?.customId);
                  const holdsError = () => {
                    const current = row();
                    const refusal = props.refusals.get(first.key);
                    return current.kind === "file"
                      ? wordsOf(...current.problems, refusal?.file)
                      : wordsOf(refusal?.input);
                  };
                  // Rows already need their own names and focus IDs. With UI SDK field parts,
                  // adding 1,000 typed rows took 1,925 ms versus 431 ms with native controls.
                  return (
                    <tr role="row" id={id}>
                      <td role="cell" class="num" data-l="Job">
                        {formatCount(number())}
                      </td>
                      <td role="cell" class="is-id" data-l="Custom ID">
                        <input
                          id={rowControlId(first.key, "customId")}
                          name={`jobs[${index()}][customId]`}
                          aria-label={`Custom ID of job ${number()}`}
                          aria-invalid={idError() ? "true" : undefined}
                          aria-describedby={idError() ? `${id}-id-error` : undefined}
                          defaultValue={first.customId}
                          required
                          spellcheck={false}
                          autocapitalize="off"
                          readonly={props.pending}
                          onInput={() => props.onEdited(first.key, "customId")}
                        />
                        <Show when={idError()} keyed>
                          {(words) => (
                            <p class="field-error" id={`${id}-id-error`}>
                              <FieldError>{words}</FieldError>
                            </p>
                          )}
                        </Show>
                      </td>
                      <Show
                        when={first.kind === "file" && first}
                        fallback={
                          <td role="cell" data-l="Input">
                            <textarea
                              id={rowControlId(first.key, "input")}
                              name={`jobs[${index()}][input]`}
                              aria-label={`Input of job ${number()}`}
                              aria-invalid={holdsError() ? "true" : undefined}
                              aria-describedby={holdsError() ? `${id}-input-error` : undefined}
                              // Three rows: a short input shows whole, a longer one scrolls.
                              rows={3}
                              required
                              readonly={props.pending}
                              onInput={() => props.onEdited(first.key, "input")}
                            />
                            <Show when={holdsError()} keyed>
                              {(words) => (
                                <p class="field-error" id={`${id}-input-error`}>
                                  <FieldError>{words}</FieldError>
                                </p>
                              )}
                            </Show>
                          </td>
                        }
                      >
                        {(job) => (
                          // A refused file's cell holds the focus a refusal moves to it.
                          <td
                            id={rowControlId(first.key, "file")}
                            role="cell"
                            class="is-file"
                            data-l="File"
                            aria-invalid={holdsError() ? "true" : undefined}
                            aria-describedby={holdsError() ? `${id}-file-error` : undefined}
                            tabindex={holdsError() ? -1 : undefined}
                          >
                            <span class="file">
                              <span class="cut mono" title={job().file.name}>
                                {job().file.name}
                              </span>{" "}
                              <span class="num">{formatBytes(job().file.size)}</span>
                            </span>
                            <Show when={holdsError()} keyed>
                              {(words) => (
                                <p class="field-error" id={`${id}-file-error`}>
                                  <FieldError>{words}</FieldError>
                                </p>
                              )}
                            </Show>
                          </td>
                        )}
                      </Show>
                      <td role="cell" class="is-act">
                        <Button
                          aria-label={`Remove job ${number()}`}
                          disabled={props.pending}
                          focusableWhenDisabled
                          onClick={(event) => remove(row(), number(), event.currentTarget)}
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>
        </Show>
      </FieldGroup>
      {/* Beside the group rather than in it: either question leaves out of what it makes inert a
          live region and what holds it, and the group, then inert whole, takes no file dropped
          while it is open. */}
      <p role="status" class="vh">
        {said()}
      </p>
      <RemoveAllDialog
        controller={confirmRemoveAll.controller}
        opener={() => removeAllButton}
        jobs={props.rows.length}
        mayHaveBatch={props.mayHaveBatch}
        typedInputs={props.jobs.filter((job) => job.kind === "typed" && job.input !== "").length}
        files={props.rows.some((row) => row.kind === "file")}
      />
    </>
  );
}

/**
 * Asks before every row goes, saying what is lost and what is not. `mayHaveBatch`: a send got no
 * answer, so the hub may have a Batch with these jobs. Not `ConfirmDialog`, whose confirming button
 * runs a request and waits for the hub: removing rows sends nothing, so Remove all asks through
 * `createConfirm` and removes them once the answer is in.
 */
function RemoveAllDialog(props: {
  controller: AlertDialogController<undefined>;
  /** Remove all, where focus returns. */
  opener: () => HTMLElement | undefined;
  jobs: number;
  mayHaveBatch: boolean;
  typedInputs: number;
  files: boolean;
}) {
  const jobs = () => `${formatCount(props.jobs)} ${plural(props.jobs, "job", "jobs")}`;
  return (
    <AlertDialog
      controller={props.controller}
      // Into the body, as `ConfirmDialog` does and for its reason; out of the page's form too, so
      // none of its buttons can submit it.
      container={document.body}
    >
      {/* Opened from code, it would return focus to what had it at the press, which is not Remove all
          when the press does not focus it, as a click does not in Safari. */}
      <AlertDialogContent finalFocus={props.opener}>
        <AlertDialogTitle class="dialog-h">
          {plural(props.jobs, "Remove the job?", `Remove all ${jobs()}?`)}
        </AlertDialogTitle>
        <AlertDialogDescription class="dialog-b">
          {/* After a lost answer the hub may have them, and removing rows here removes nothing there. */}
          {props.mayHaveBatch
            ? ""
            : `${plural(props.jobs, "It has", "They have")} not been submitted. `}
          Removing {plural(props.jobs, "it", "them")} here loses{" "}
          {props.typedInputs
            ? `the ${formatCount(props.typedInputs)} ${plural(props.typedInputs, "input", "inputs")} you typed and `
            : ""}
          every Custom ID you changed{props.files ? "; the files stay on your computer." : "."}
          {props.mayHaveBatch ? " A Batch the hub may already have keeps its jobs." : ""}
        </AlertDialogDescription>
        <div class="dialog-f">
          <AlertDialogClose>{plural(props.jobs, "Keep it", "Keep them")}</AlertDialogClose>
          <AlertDialogClose value="confirm" class="danger is-fill">
            Remove {jobs()}
          </AlertDialogClose>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
