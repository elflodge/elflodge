import { ORPCError } from "@orpc/client";
import { isSchemaIssue } from "@orpc/contract";
import { useQueryClient } from "@tanstack/solid-query";
import { createFileRoute, useRouter } from "@tanstack/solid-router";
import { BATCH_ID_PATTERN, BREAKER_DEFAULTS, MAX_BATCH_ID_LENGTH } from "contract";
import {
  For,
  Show,
  createMemo,
  createOptimistic,
  createSignal,
  onCleanup,
  onSettled,
} from "solid-js";

import { hubFailureMessage } from "../../../api-client.ts";
import {
  type BatchDraft,
  type Creation,
  draftFacts,
  fileProblems,
  repeatedCustomIds,
} from "../../../batch-draft.ts";
import { type SendProgress, sendBatch } from "../../../batch-send.ts";
import {
  AgentFields,
  agentControls,
  agentFields,
  agentOf,
  figureIn,
} from "../../../components/AgentFields.tsx";
import {
  type DraftRow,
  DraftJobs,
  RemoveAllDialog,
  type RowRefusal,
  rowControlId,
} from "../../../components/DraftJobs.tsx";
import {
  LeaveDialog,
  createDraftSubmission,
  madeIdUnknownWords,
  type SentUnder,
} from "../../../components/DraftSubmission.tsx";
import { Field, FieldGroup } from "../../../components/Field.tsx";
import { LabelFields, isLabelsControl, labelsOf } from "../../../components/LabelFields.tsx";
import { Notice } from "../../../components/Notice.tsx";
import { RecordCrumbs } from "../../../components/RecordCrumbs.tsx";
import { createFormAction, fieldText, formRefusal } from "../../../form.ts";
import { formatBytes } from "../../../format-bytes.ts";
import { USD_BUDGET, formatCount, plural } from "../../../format.ts";
import { preloadJobLimits, useJobLimits } from "../../../job-limits.ts";
import { orpc } from "../../../query.ts";

// Not /batches/new, which is the page of a Batch named "new". "-" is a segment no Batch ID can be,
// so no Batch's page has this address, and the bar marks Batches. The router ignores a file name's
// leading "-" only, so this one is routed.
export const Route = createFileRoute("/_signed-in/_member/batches_/-/new")({
  loader: ({ context }) => preloadJobLimits(context),
  component: SubmitBatch,
});

const breakerFields = {
  canary: "breaker[canary]",
  maxFailurePercent: "breaker[maxFailurePercent]",
} as const;

// Issues of a job are placed at its row, by the page; these are the form's other controls.
const controls = {
  id: ["id"],
  ...agentControls,
  [breakerFields.canary]: [breakerFields.canary],
  [breakerFields.maxFailurePercent]: [breakerFields.maxFailurePercent],
  breaker: ["breaker"],
  jobs: ["jobs"],
};

/** The length of the ID the page makes, a UUID, for the size of a request before it is made. */
const MADE_ID_FORM = "00000000-0000-4000-8000-000000000000";

const AGAIN = "Submit again reads the files again and uploads only what the hub does not hold.";

/**
 * Part of an alert's words: text, a command, or the sentence that no Batch came of this try, whose
 * words depend on whether an earlier try may have made one.
 */
type AlertPart = string | { readonly code: string } | { readonly noBatch: true };

/** What stopped a send at its rows, which the alert counts and links as they stand. */
type RowsLead = "cannot be sent" | "refused" | "unreadable" | "not uploaded";

/** A row whose words stand, and the part of it that carries them. */
interface RowTarget {
  readonly key: number;
  readonly part: keyof RowRefusal;
}

/** How the last send ended, where the page tells it. */
interface Ending {
  readonly fields: ReadonlyMap<string, string>;
  readonly rows: ReadonlyMap<number, RowRefusal>;
  readonly lead?: RowsLead;
  /** The alert's words after the rows'. */
  readonly alert?: readonly AlertPart[];
  readonly stopped?: true;
}

const NO_ENDING: Ending = { fields: new Map(), rows: new Map() };

/** That no Batch came of this try: after a lost answer an earlier try may have made it. */
function noBatchWords(mayHaveBatch: boolean) {
  return mayHaveBatch ? "This try did not send the Batch." : "No Batch was created.";
}

/** The sentence that leads to `count` rows stopped by `lead`. */
function leadWords(lead: RowsLead, count: number, mayHaveBatch: boolean) {
  const one = count === 1;
  const jobs = one ? "1 job" : `${formatCount(count)} jobs`;
  const files = one ? "1 file" : `${formatCount(count)} files`;
  const noBatch = noBatchWords(mayHaveBatch);
  const words: Record<RowsLead, string> = {
    "cannot be sent": `${jobs} cannot be sent.`,
    refused: `${jobs} ${one ? "was" : "were"} refused.`,
    unreadable: `${files} could not be read, so nothing was sent.`,
    "not uploaded": `${files} ${one ? "was" : "were"} not uploaded, so ${noBatch.charAt(0).toLowerCase()}${noBatch.slice(1)}`,
  };
  return words[lead];
}

/**
 * The issues of `issues` that concern a job, at its row by the job's index in `rows`, under its
 * Custom ID, its input or its file; and the others, for the form's controls.
 */
function splitRowIssues(issues: readonly unknown[], rows: readonly DraftRow[]) {
  const atRows = new Map<number, RowRefusal>();
  const rest: unknown[] = [];
  for (const issue of issues) {
    const path = isSchemaIssue(issue)
      ? (issue.path ?? []).map((part) => (typeof part === "object" ? part.key : part))
      : [];
    // The hub's answer locates a problem by a JSON pointer, so its indexes arrive as text.
    const index = path[0] === "jobs" ? Number(path[1]) : Number.NaN;
    const row = Number.isInteger(index) ? rows[index] : undefined;
    if (!row || !isSchemaIssue(issue)) {
      rest.push(issue);
      continue;
    }
    const part = path[2] === "input" ? "input" : path[2] === "files" ? "file" : "customId";
    const previous = atRows.get(row.key);
    atRows.set(row.key, {
      ...previous,
      [part]: [previous?.[part], issue.message].filter(Boolean).join("\n"),
    });
  }
  return { atRows, rest };
}

/** What the alert adds while the outcome of a send under `sentUnder` is unknown. */
function unknownWords(sentUnder: SentUnder | undefined) {
  if (sentUnder === "made ID") return madeIdUnknownWords("Batch");
  // A create repeated under an existing Batch ID returns that Batch for the same agent, Labels
  // and breaker, and refuses others at the Batch ID. The hub knows a job by its Custom ID: the
  // same content returns the job, other content is refused at that Custom ID, a new Custom ID
  // adds a job, and a job left out stays. So a row renamed here becomes a second job while the
  // first stays. One conflict refuses the whole request, which then adds no job.
  if (sentUnder === "typed ID")
    return "The hub may already have a Batch under this Batch ID. Submit again without changing anything to find out: the same values return that Batch. If it was made, a change here does not edit it: a changed field is refused at Batch ID, a changed job at its Custom ID, and the Batch keeps every job it has and takes any job with a new Custom ID.";
  return undefined;
}

function SubmitBatch() {
  const router = useRouter();
  const client = useQueryClient();
  const limits = useJobLimits();
  let nextRow = 0;
  const [rows, setRows] = createSignal<readonly DraftRow[]>([]);
  // The rows as last checked for Custom IDs given twice: when rows are added or removed, when a
  // Custom ID is changed and its field left, and at Submit.
  const [checkedRows, setCheckedRows] = createSignal<readonly DraftRow[]>([]);
  const repeated = createMemo(() => {
    const checked = checkedRows();
    return new Map(
      [...repeatedCustomIds(checked)].flatMap(([index, message]) => {
        const row = checked[index];
        return row ? [[row.key, message] as const] : [];
      }),
    );
  });
  const [breakerOn, setBreakerOn] = createSignal(true);
  const [askingRemoveAll, setAskingRemoveAll] = createSignal(false);
  let jobsList: { readonly removeAll: () => void } | undefined;
  const [ending, setEnding] = createSignal<Ending>(NO_ENDING);
  // Optimistic, as the form's pending state is: a send is one action, whose other writes show once
  // it settles, while its progress must show as it goes.
  const [progress, setProgress] = createOptimistic<SendProgress | undefined>(undefined);
  // Changes when any field changes, so the facts read the form again.
  const [edits, setEdits] = createSignal(0);
  let formElement: HTMLFormElement | undefined;
  let sendController: AbortController | undefined;
  // A send still reading or uploading stops when the page goes.
  onCleanup(() => sendController?.abort());

  const submission = createDraftSubmission(
    () =>
      rows().length > 0 ||
      Array.from(formElement?.elements ?? []).some((control) =>
        control instanceof HTMLInputElement && control.type === "checkbox"
          ? control.checked !== control.defaultChecked
          : (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) &&
            (control.value !== control.defaultValue || control.validity.badInput),
      ),
  );

  function breakerOf(form: HTMLFormElement): Creation["breaker"] {
    if (!breakerOn()) return false;
    return {
      canary: figureIn(form, breakerFields.canary),
      maxFailurePercent: figureIn(form, breakerFields.maxFailurePercent),
    };
  }
  /** The draft the form holds, read from `data`, its one snapshot, with the ID to send it under. */
  function draftOf(form: HTMLFormElement, data: FormData, id: string) {
    const { agent, schemaRefusal } = agentOf(form, data);
    const labels = labelsOf(data);
    const draft: BatchDraft = {
      id,
      agent,
      labels: labels.labels,
      breaker: breakerOf(form),
      jobs: rows(),
    };
    return { draft, schemaRefusal, labelControls: labels.controls };
  }
  const facts = createMemo(() => {
    edits();
    const form = formElement;
    if (!form) {
      const blank = { id: MADE_ID_FORM, agent: { outputContract: { schema: {} } }, jobs: rows() };
      return draftFacts(blank, limits.held());
    }
    const data = new FormData(form);
    const id = fieldText(data, "id") || (submission.madeId() ?? MADE_ID_FORM);
    return draftFacts(draftOf(form, data, id).draft, limits.held());
  });
  onSettled(() => {
    setEdits((count) => count + 1);
  });

  /** Sets the rows, and checks their Custom IDs: a signal reads as set only once it is flushed. */
  function setDraftRows(next: readonly DraftRow[]) {
    setRows(next);
    setCheckedRows(next);
  }
  function changed() {
    submission.changed(false);
    setEdits((count) => count + 1);
  }
  function setRowRefusals(update: (rows: Map<number, RowRefusal>) => void) {
    setEnding((previous) => {
      const next = new Map(previous.rows);
      update(next);
      return { ...previous, rows: next };
    });
  }

  const { pending, onSubmit } = createFormAction(async (form) => {
    submission.sending();
    setCheckedRows(rows());
    const data = new FormData(form);
    const { id, sentUnder } = submission.takeId(fieldText(data, "id"));
    const { draft, schemaRefusal, labelControls } = draftOf(form, data, id);
    if (schemaRefusal) {
      setEnding({ ...NO_ENDING, fields: new Map([[agentFields.outputSchema, schemaRefusal]]) });
      return;
    }
    const placed = { ...controls, ...labelControls };
    const sent = rows();
    const keyOf = (index: number) => sent[index]?.key ?? -1;
    sendController = new AbortController();
    const outcome = await sendBatch(draft, {
      signal: sendController.signal,
      onProgress: setProgress,
    }).finally(() => {
      sendController = undefined;
      setProgress(undefined);
    });
    function refusedBy(issues: readonly unknown[]): Ending {
      const { atRows, rest } = splitRowIssues(issues, sent);
      const refusal = formRefusal(new ORPCError("BAD_REQUEST", { data: { issues: rest } }), placed);
      return {
        fields: refusal.fields,
        rows: atRows,
        lead: "refused",
        alert: refusal.alert ? [refusal.alert] : [],
      };
    }
    switch (outcome.kind) {
      case "created": {
        const { jobs: _jobs, ...batch } = outcome.answer;
        // The answer names each job by its IDs alone, so the Batch's page reads its jobs. An older
        // read of a Batch under a reused ID must not overwrite the answer.
        const batchKey = orpc.batches.get.queryKey({ input: { id: batch.id } });
        await client.cancelQueries({ queryKey: batchKey, exact: true });
        client.setQueryData(batchKey, batch);
        void client.invalidateQueries({ queryKey: orpc.jobs.list.key() });
        void client.invalidateQueries({ queryKey: orpc.jobs.counts.key() });
        void client.invalidateQueries({ queryKey: orpc.batches.list.key() });
        if (submission.markSucceeded(form, sentUnder))
          await router.navigate({ to: "/batches/$id", params: { id: batch.id } });
        else setEnding(NO_ENDING);
        return;
      }
      case "stopped":
        setEnding({ ...NO_ENDING, stopped: true });
        return;
      case "refusedAtAdd":
        // The rows' words are what they were told when added, which stand until fixed.
        setEnding({ ...NO_ENDING, lead: "cannot be sent" });
        return;
      case "unreadable":
        setEnding({
          ...NO_ENDING,
          rows: new Map(
            outcome.jobs.map(({ index, message }) => [
              keyOf(index),
              { file: `The file could not be read: ${message}\nRemove it and add it again.` },
            ]),
          ),
          lead: "unreadable",
        });
        return;
      case "invalid":
        setEnding(refusedBy(outcome.issues));
        return;
      case "tooLarge":
        setEnding({
          ...NO_ENDING,
          alert: [
            `The text to send is ${formatBytes(outcome.bytes)}, and one request takes at most ${formatBytes(outcome.max)}. Shorten the typed inputs, or submit with the CLI, which sends a Batch in several requests: `,
            { code: "elflodge batches submit" },
          ],
        });
        return;
      case "checkFailed":
        setEnding({
          ...NO_ENDING,
          alert: [`${hubFailureMessage(outcome.error)}\n`, { noBatch: true }, ` ${AGAIN}`],
        });
        return;
      case "notUploaded":
        setEnding({
          ...NO_ENDING,
          rows: new Map(
            outcome.jobs.map(({ index, message }) => [keyOf(index), { file: message }]),
          ),
          lead: "not uploaded",
          alert: [AGAIN],
        });
        return;
      case "createFailed": {
        const { error } = outcome;
        submission.markFailed(error, sentUnder);
        if (error instanceof ORPCError && Array.isArray(error.data?.issues))
          setEnding(refusedBy(error.data.issues));
        else setEnding({ ...NO_ENDING, alert: [hubFailureMessage(error)] });
        return;
      }
    }
  });

  // The previous ending belongs to the last attempt while the next one is pending.
  const shown = () => (pending() ? NO_ENDING : ending());
  const refused = (name: string) => shown().fields.get(name);
  const mayHaveBatch = () => submission.unknownOutcome() !== undefined;
  /** The rows whose words stand now, in the list's order, each at the part that carries them. */
  const standing = (): RowTarget[] => {
    const { lead, rows: refusals } = shown();
    if (!lead) return [];
    return rows().flatMap((row): RowTarget[] => {
      if (lead === "cannot be sent") {
        if (repeated().has(row.key)) return [{ key: row.key, part: "customId" }];
        return row.problems.length ? [{ key: row.key, part: "file" }] : [];
      }
      const refusal = refusals.get(row.key);
      const part = refusal?.file
        ? "file"
        : refusal?.input
          ? "input"
          : refusal?.customId && "customId";
      return part ? [{ key: row.key, part }] : [];
    });
  };
  // Derived from the refusals that stand, so an edit or a removal changes the count and links.
  const alert = () => {
    if (pending()) return undefined;
    const { lead, alert: after = [] } = ending();
    const targets = standing();
    const rowsLead =
      lead && targets.length
        ? `${leadWords(lead, targets.length, mayHaveBatch())} ${targets.length === 1 ? "It says" : "Each says"} why at its row: `
        : undefined;
    const unknown = unknownWords(submission.unknownOutcome());
    if (!rowsLead && !after.length && !unknown) return undefined;
    return { rowsLead, targets, after, unknown };
  };
  const rowNumber = (key: number) => rows().findIndex((row) => row.key === key) + 1;

  function clearRefusal(name: string) {
    setEnding((previous) => {
      if (!previous.fields.has(name)) return previous;
      const fields = new Map(previous.fields);
      fields.delete(name);
      return { ...previous, fields };
    });
  }

  return (
    <>
      <RecordCrumbs to="/batches" />
      <div class="head">
        <h1>Submit a Batch</h1>
      </div>
      <form
        class="fields is-wide"
        ref={(form) => {
          formElement = form;
        }}
        autocomplete="off"
        onSubmit={onSubmit}
        onInput={(event) => {
          const control = event.target;
          if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement))
            return;
          submission.changed(control.name === "id");
          setEdits((count) => count + 1);
          clearRefusal(control.name);
        }}
      >
        <p class="note">
          A Batch runs one agent on many jobs. Say what the agent does, then add the jobs.
        </p>
        <AgentFields
          of="Batch"
          pending={pending()}
          refused={refused}
          afterSchema={
            <Field
              label="Batch ID"
              hint={
                <>
                  Optional. Names the Batch: 1 to {MAX_BATCH_ID_LENGTH} letters, digits,{" "}
                  <code>_</code> and <code>-</code>, not beginning with <code>-</code>. Left empty,
                  one is made.
                </>
              }
              error={refused("id")}
            >
              {(control) => (
                <input
                  {...control}
                  name="id"
                  pattern={BATCH_ID_PATTERN.source}
                  title="Letters, digits, _ and -, not beginning with -"
                  spellcheck={false}
                  autocapitalize="off"
                  readonly={pending()}
                />
              )}
            </Field>
          }
        />
        <LabelFields
          hint="Optional. Every job of the Batch carries them, and Usage can group cost by a key."
          pending={pending()}
          refused={refused}
          onChange={() => {
            changed();
            setEnding((previous) => ({
              ...previous,
              fields: new Map([...previous.fields].filter(([name]) => !isLabelsControl(name))),
            }));
          }}
        />
        <FieldGroup
          label="Failure breaker"
          hint="Pauses the Batch when its jobs fail, so a flaw they share shows after a few jobs instead of after all of them."
          error={refused("breaker")}
        >
          <label class="check">
            <input
              type="checkbox"
              name="breaker"
              checked
              onClick={(event) => {
                if (pending()) event.preventDefault();
              }}
              onChange={(event) => setBreakerOn(event.currentTarget.checked)}
            />
            Pause the Batch when jobs fail
          </label>
          <Field
            label="Canary"
            unit="jobs"
            hint="The Batch’s first jobs run before the rest are released, and any of them failing pauses the Batch. 0 for none."
            error={refused(breakerFields.canary)}
          >
            {(control) => (
              <input
                {...control}
                name={breakerFields.canary}
                type="number"
                min="0"
                step="1"
                required
                defaultValue={String(BREAKER_DEFAULTS.canary)}
                disabled={!breakerOn()}
                readonly={pending()}
              />
            )}
          </Field>
          <Field
            label="Failure limit"
            unit="% of the jobs ended"
            hint="After the Canary, the Batch pauses once more than this share of its ended jobs have failed. 100 keeps the Canary alone."
            error={refused(breakerFields.maxFailurePercent)}
          >
            {(control) => (
              <input
                {...control}
                name={breakerFields.maxFailurePercent}
                type="number"
                min="0"
                max="100"
                step="any"
                required
                defaultValue={String(BREAKER_DEFAULTS.maxFailurePercent)}
                disabled={!breakerOn()}
                readonly={pending()}
              />
            )}
          </Field>
        </FieldGroup>
        <DraftJobs
          rows={rows()}
          repeated={repeated()}
          refusals={shown().rows}
          error={refused("jobs")}
          pending={pending()}
          after="submit-facts"
          hint={
            <>
              Each job runs the agent once. A job from a file gives the agent that file in its{" "}
              <code>inputs</code> folder and no input of its own, so Instructions must say what to
              do with it. A typed job gives it the text you type. For more jobs than this page
              takes, use the CLI: <code>elflodge batches submit</code>
            </>
          }
          onAdd={(jobs) => {
            setDraftRows([
              ...rows(),
              ...jobs.map((job) => ({
                ...job,
                key: nextRow++,
                problems: job.kind === "file" ? fileProblems(job.file) : [],
              })),
            ]);
            changed();
            clearRefusal("jobs");
          }}
          onRemove={(which) => {
            setDraftRows(which === "all" ? [] : rows().filter((row) => row.key !== which));
            setRowRefusals((refusals) => {
              if (which === "all") refusals.clear();
              else refusals.delete(which);
            });
            changed();
          }}
          onEdit={(key, edit) => {
            // The check for Custom IDs given twice waits until the field is left.
            setRows(rows().map((row) => (row.key === key ? { ...row, ...edit } : row)));
            setRowRefusals((refusals) => {
              const refusal = refusals.get(key);
              if (!refusal) return;
              const part = "customId" in edit ? "customId" : "input";
              refusals.set(key, { ...refusal, [part]: undefined });
            });
          }}
          onIdChanged={() => setCheckedRows(rows())}
          onAskRemoveAll={() => setAskingRemoveAll(true)}
          ref={(handle) => {
            jobsList = handle;
          }}
        />
        <Facts facts={facts()} limitsFailed={limits.failed()} />
        <Show when={shown().stopped}>
          <Notice role="status">
            Stopped. {noBatchWords(mayHaveBatch())} {AGAIN}
          </Notice>
        </Show>
        <Show when={alert()}>
          {(words) => (
            <Notice role="alert">
              <Show when={words().rowsLead}>
                {(lead) => (
                  <>
                    {lead()}
                    <RowLinks targets={words().targets} numberOf={rowNumber} />
                  </>
                )}
              </Show>
              <Show when={words().after.length}>
                {words().rowsLead ? "\n" : ""}
                <AlertWords parts={words().after} mayHaveBatch={mayHaveBatch()} />
              </Show>
              <Show when={words().unknown}>
                {(unknown) => (
                  <>
                    {words().rowsLead || words().after.length ? "\n" : ""}
                    {unknown()}
                  </>
                )}
              </Show>
            </Notice>
          )}
        </Show>
        <div class="controls">
          <button class="primary" type="submit" aria-disabled={pending() ? "true" : undefined}>
            Submit Batch
          </button>
          <Show when={progress()?.step === "reading" || progress()?.step === "uploading"}>
            <button type="button" onClick={() => sendController?.abort()}>
              Stop
            </button>
          </Show>
        </div>
        <Sending progress={progress()} />
      </form>
      {/* Outside the form, as the leave dialog is: its own form must not submit the Batch's. */}
      <Show when={askingRemoveAll()}>
        <RemoveAllDialog
          jobs={rows().length}
          mayHaveBatch={mayHaveBatch()}
          typedInputs={rows().filter((row) => row.kind === "typed" && row.input !== "").length}
          files={rows().some((row) => row.kind === "file")}
          onClose={() => setAskingRemoveAll(false)}
          onConfirm={() => jobsList?.removeAll()}
        />
      </Show>
      <Show when={submission.blocker().status === "blocked"}>
        <LeaveDialog
          submission={submission}
          mayHaveRecord={
            progress()?.step === "creating" || submission.unknownOutcome() !== undefined
          }
          record="Batch"
          list="Batches"
          loses="what you typed and the jobs you added"
        />
      </Show>
    </>
  );
}

/** An alert's words, with its commands. */
function AlertWords(props: { parts: readonly AlertPart[]; mayHaveBatch: boolean }) {
  return (
    <For each={props.parts}>
      {(value) => {
        if (typeof value === "string") return value;
        if ("code" in value) return <code>{value.code}</code>;
        return noBatchWords(props.mayHaveBatch);
      }}
    </For>
  );
}

/**
 * Links to the rows `targets`, each to the control that carries its words, numbered as the list
 * numbers them now: ten, then how many more. Ten is a choice of what an alert can hold and still be
 * read, not a measured limit.
 */
function RowLinks(props: { targets: readonly RowTarget[]; numberOf: (key: number) => number }) {
  return (
    <>
      <For each={props.targets.slice(0, 10)}>
        {(target, index) => (
          <>
            {index() > 0 ? ", " : ""}
            <a
              href={`#${rowControlId(target.key, target.part)}`}
              onClick={(event) => {
                event.preventDefault();
                const control = document.getElementById(rowControlId(target.key, target.part));
                control?.focus();
                control?.scrollIntoView({ block: "center" });
              }}
            >
              {formatCount(props.numberOf(target.key))}
            </a>
          </>
        )}
      </For>
      {props.targets.length > 10 ? ` and ${formatCount(props.targets.length - 10)} more` : ""}
    </>
  );
}

/**
 * A figure beside its limit. Past it, in the failed colour with the error mark, followed by
 * `over`, how far past it in words: the mark is not read, and a rounded figure can hide a small
 * excess, as 16 MiB and 100 bytes reads "16 MiB".
 */
function AgainstLimit(props: { over: string | undefined; children: string }) {
  return (
    <Show when={props.over} fallback={props.children}>
      {(over) => (
        <span class="is-over">
          <span class="mark mark-error" aria-hidden="true" />
          {`${props.children}, ${over()}`}
        </span>
      )}
    </Show>
  );
}

/** What Submit sends, against what one request and one file take, kept current as the form changes. */
function Facts(props: { facts: ReturnType<typeof draftFacts>; limitsFailed: boolean }) {
  const jobs = () => props.facts.jobs;
  const request = () => props.facts.request;
  const files = () => props.facts.files;
  const budgets = () => props.facts.budgets;
  return (
    <dl id="submit-facts" tabindex="-1" aria-label="What Submit sends">
      <dt>Jobs</dt>
      <dd>
        <AgainstLimit
          over={
            jobs().count > jobs().max ? `${formatCount(jobs().count - jobs().max)} over` : undefined
          }
        >
          {`${formatCount(jobs().count)} of at most ${formatCount(jobs().max)}`}
        </AgainstLimit>
        {jobs().count
          ? `: ${formatCount(jobs().fromFiles)} from files, ${formatCount(jobs().typed)} typed`
          : ""}
      </dd>
      <dt>Text</dt>
      <dd>
        <AgainstLimit
          over={
            request().bytes > request().max
              ? `${formatBytes(request().bytes - request().max)} over`
              : undefined
          }
        >
          {`${formatBytes(request().bytes)} of at most ${formatBytes(request().max)}`}
        </AgainstLimit>
        : everything sent but the files’ contents
      </dd>
      <dt>Files</dt>
      <dd>
        {files().count ? `${formatCount(files().count)}, ${formatBytes(files().bytes)}` : "None"};{" "}
        <AgainstLimit
          over={
            files().overMax
              ? `${formatCount(files().overMax)} ${plural(files().overMax, "file", "files")} over`
              : undefined
          }
        >
          {`each at most ${formatBytes(files().maxEach)}`}
        </AgainstLimit>
      </dd>
      <dt>Model budgets</dt>
      <dd>
        {(() => {
          const known = budgets();
          if (known.from === "unknown")
            return `The hub’s default for each job${props.limitsFailed ? "; the hub’s limits could not be read" : ""}`;
          const source = known.from === "set" ? "as set above" : "the hub’s default";
          const each = USD_BUDGET.format(known.eachUsd);
          return jobs().count ? (
            <>
              {USD_BUDGET.format(known.totalUsd)} <span class="unit">USD</span> in all:{" "}
              {formatCount(jobs().count)} {plural(jobs().count, "job", "jobs")} at {each} each,{" "}
              {source}
            </>
          ) : (
            <>
              {each} <span class="unit">USD</span> a job, {source}
            </>
          );
        })()}
      </dd>
    </dl>
  );
}

/** What the form is doing while it sends: the step, how far, and the figures. */
function Sending(props: { progress: SendProgress | undefined }) {
  const reading = () => (props.progress?.step === "reading" ? props.progress : undefined);
  const uploading = () => (props.progress?.step === "uploading" ? props.progress : undefined);
  const words = () => {
    switch (props.progress?.step) {
      case "reading":
        return "Reading the files";
      case "uploading":
        return "Uploading the files the hub does not hold";
      case "creating":
        return "Creating the Batch…";
      default:
        return "";
    }
  };
  return (
    <div class={props.progress ? "sending" : undefined}>
      <p role="status" class={props.progress ? "note" : "vh"}>
        {words()}
      </p>
      <Show when={reading()}>
        {(read) => (
          <>
            <progress value={read().read} max={read().files} aria-label={words()} />
            <p class="note">
              {formatCount(read().read)} of {formatCount(read().files)}{" "}
              {plural(read().files, "file", "files")} read
            </p>
          </>
        )}
      </Show>
      <Show when={uploading()}>
        {(upload) => (
          <>
            <progress value={upload().uploadedBytes} max={upload().bytes} aria-label={words()} />
            <p class="note">
              {[
                `Uploaded ${formatCount(upload().uploaded)} of ${formatCount(upload().files)} ${plural(upload().files, "file", "files")}, ${formatBytes(upload().uploadedBytes)} of ${formatBytes(upload().bytes)}.`,
                upload().held > 0 && `The hub already holds ${formatCount(upload().held)}.`,
                upload().same > 0 &&
                  `${formatCount(upload().same)} ${plural(upload().same, "has", "have")} the same content as another file being uploaded.`,
              ]
                .filter(Boolean)
                .join(" ")}
            </p>
          </>
        )}
      </Show>
    </div>
  );
}
