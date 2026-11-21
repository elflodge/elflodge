import type { JSX } from "@solidjs/web";
import { For, Show, createSignal, createUniqueId, flush, onSettled } from "solid-js";

import { type DraftJob, fileJobs, typedJob } from "../batch-draft.ts";
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

/** The text `form`'s control `name` holds, or "" when it has none. */
function textOf(form: HTMLFormElement, name: string) {
  const control = form.elements.namedItem(name);
  return control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement
    ? control.value
    : "";
}

/** The jobs of `rows` as `form` holds them now, each row's fields read by its place in the list. */
export function jobsOf(form: HTMLFormElement, rows: readonly DraftRow[]): DraftJob[] {
  return rows.map((row, index) => {
    const customId = textOf(form, `jobs[${index}][customId]`);
    return row.kind === "file"
      ? { kind: "file", customId, file: row.file }
      : { kind: "typed", customId, input: textOf(form, `jobs[${index}][input]`) };
  });
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
  /**
   * Remove all was pressed: the page asks with `RemoveAllDialog`, outside its form, and confirms
   * through the handle given to `ref`.
   */
  onAskRemoveAll: () => void;
  ref: (handle: { readonly removeAll: () => void }) => void;
}) {
  const [said, setSaid] = createSignal("");
  const [receiving, setReceiving] = createSignal(false);
  let chooser: HTMLInputElement | undefined;
  let addFilesButton: HTMLButtonElement | undefined;
  let addJobButton: HTMLButtonElement | undefined;

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
  function remove(row: DraftRow, number: number, button: HTMLButtonElement) {
    if (props.pending) return;
    // Focus moves to the row that takes this one's place, or the one before, before this one goes.
    const line = button.closest("tr");
    const next = line?.nextElementSibling ?? line?.previousElementSibling;
    (next?.querySelector<HTMLElement>("td.is-act button") ?? addJobButton)?.focus();
    props.onRemove(row.key);
    setSaid(`Job ${formatCount(number)} removed.`);
  }
  props.ref({
    removeAll() {
      const count = props.rows.length;
      props.onRemove("all");
      setSaid(count === 1 ? "Job 1 removed." : `All ${formatCount(count)} jobs removed.`);
      flush();
      addFilesButton?.focus();
    },
  });

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
          <button
            type="button"
            ref={(element) => {
              addFilesButton = element;
            }}
            aria-disabled={props.pending ? "true" : undefined}
            onClick={() => {
              if (!props.pending) chooser?.click();
            }}
          >
            Add files
          </button>
          <button
            type="button"
            ref={(element) => {
              addJobButton = element;
            }}
            aria-disabled={props.pending ? "true" : undefined}
            onClick={addTyped}
          >
            Add a job
          </button>
          <Show when={props.rows.length}>
            <button
              type="button"
              aria-disabled={props.pending ? "true" : undefined}
              onClick={() => {
                if (!props.pending) props.onAskRemoveAll();
              }}
            >
              Remove all
            </button>
          </Show>
        </div>
        <Show when={receiving()}>
          <p class="note drop-note">Drop the files to add a job for each.</p>
        </Show>
        <Show when={!props.rows.length && !receiving()}>
          <p class="note">No jobs yet. Files can also be dropped here.</p>
        </Show>
        <p role="status" class="vh">
          {said()}
        </p>
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
                  const idError = () =>
                    [props.repeated.get(first.key), props.refusals.get(first.key)?.customId]
                      .filter(Boolean)
                      .join("\n") || undefined;
                  const holdsError = () => {
                    const current = row();
                    const refusal = props.refusals.get(first.key);
                    return (
                      (current.kind === "file"
                        ? [...current.problems, refusal?.file]
                        : [refusal?.input]
                      )
                        .filter(Boolean)
                        .join("\n") || undefined
                    );
                  };
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
                        <Show when={idError()}>
                          {(words) => <FieldError id={`${id}-id-error`}>{words()}</FieldError>}
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
                            <Show when={holdsError()}>
                              {(words) => (
                                <FieldError id={`${id}-input-error`}>{words()}</FieldError>
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
                            <Show when={holdsError()}>
                              {(words) => (
                                <FieldError id={`${id}-file-error`}>{words()}</FieldError>
                              )}
                            </Show>
                          </td>
                        )}
                      </Show>
                      <td role="cell" class="is-act">
                        <button
                          type="button"
                          aria-label={`Remove job ${number()}`}
                          aria-disabled={props.pending ? "true" : undefined}
                          onClick={(event) => remove(row(), number(), event.currentTarget)}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>
        </Show>
      </FieldGroup>
    </>
  );
}

/**
 * Asks before every row goes, saying what is lost and what is not. `mayHaveBatch`: a send got no
 * answer, so the hub may have a Batch with these jobs.
 */
export function RemoveAllDialog(props: {
  jobs: number;
  mayHaveBatch: boolean;
  typedInputs: number;
  files: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const headingId = createUniqueId();
  let dialog!: HTMLDialogElement;
  const jobs = () => `${formatCount(props.jobs)} ${plural(props.jobs, "job", "jobs")}`;
  return (
    <dialog
      aria-labelledby={headingId}
      ref={(element) => {
        dialog = element;
        onSettled(() => element.showModal());
      }}
      onClose={() => props.onClose()}
    >
      <form method="dialog">
        <h2 class="dialog-h" id={headingId}>
          {props.jobs === 1 ? "Remove the job?" : `Remove all ${jobs()}?`}
        </h2>
        <div class="dialog-b">
          <p>
            {/* After a lost answer the hub may have them, and removing rows here removes nothing there. */}
            {props.mayHaveBatch
              ? ""
              : `${props.jobs === 1 ? "It has" : "They have"} not been submitted. `}
            Removing {props.jobs === 1 ? "it" : "them"} here loses{" "}
            {props.typedInputs
              ? `the ${formatCount(props.typedInputs)} ${plural(props.typedInputs, "input", "inputs")} you typed and `
              : ""}
            every Custom ID you changed{props.files ? "; the files stay on your computer." : "."}
            {props.mayHaveBatch ? " A Batch the hub may already have keeps its jobs." : ""}
          </p>
        </div>
        <div class="dialog-f">
          <button value="keep" autofocus>
            {props.jobs === 1 ? "Keep it" : "Keep them"}
          </button>
          <button
            type="button"
            class="danger is-fill"
            onClick={() => {
              // Closed first: a modal dialog keeps focus from the page, and closing it returns focus
              // to Remove all, which goes with the rows.
              dialog.close();
              props.onConfirm();
            }}
          >
            Remove {jobs()}
          </button>
        </div>
      </form>
    </dialog>
  );
}
