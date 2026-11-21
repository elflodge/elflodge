import { ORPCError } from "@orpc/client";
import { isSchemaIssue } from "@orpc/contract";
import { useQueryClient } from "@tanstack/solid-query";
import { Link, createFileRoute, useRouter } from "@tanstack/solid-router";
import {
  BATCH_ID_PATTERN,
  BREAKER_DEFAULTS,
  MAX_BATCH_ID_LENGTH,
  MAX_JOBS_PER_REQUEST,
} from "contract";
import {
  For,
  Show,
  createMemo,
  createOptimistic,
  createSignal,
  flush,
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
import { type SendOutcome, type SendProgress, sendBatch } from "../../../batch-send.ts";
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
  jobsOf,
  type RowRefusal,
  rowControlId,
} from "../../../components/DraftJobs.tsx";
import {
  EarlierWords,
  LeaveDialog,
  createDraftSubmission,
} from "../../../components/DraftSubmission.tsx";
import { Field, FieldGroup } from "../../../components/Field.tsx";
import { LabelFields, isLabelsControl, labelsOf } from "../../../components/LabelFields.tsx";
import { Notice } from "../../../components/Notice.tsx";
import { RecordCrumbs } from "../../../components/RecordCrumbs.tsx";
import { createFormAction, fieldText, issuesRefusal, withoutRefusals } from "../../../form.ts";
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

/**
 * What stops a send at a row: what the page's own check finds, which the row may also have told
 * when it was added, or what the hub refused, or a file that could not be read or uploaded.
 */
type RowsKind = "cannot be sent" | "refused" | "unreadable" | "not uploaded";

/** The order in which the alert tells the rows of each kind. */
const ROWS_KINDS: readonly RowsKind[] = ["cannot be sent", "refused", "unreadable", "not uploaded"];

/** A row whose words stand, and the part of it that carries them. */
interface RowTarget {
  readonly key: number;
  readonly part: keyof RowRefusal;
}

/** How the last send ended, where the page tells it. */
interface Ending {
  readonly fields: ReadonlyMap<string, string>;
  readonly rows: ReadonlyMap<number, RowRefusal>;
  /** What stopped the send at the rows of `rows`. */
  readonly kind?: RowsKind;
  /** The alert's words after the rows'. */
  readonly alert?: readonly AlertPart[];
  readonly stopped?: true;
}

/** No send has ended, or its ending was settled: nothing is told. */
const NO_ENDING: Ending = { fields: new Map(), rows: new Map() };

/** The draft as the page last read it from the form. */
interface DraftReading {
  /** Under the Batch ID typed, or one of a made ID's length. */
  readonly draft: BatchDraft;
  readonly typedId: string;
  readonly schemaRefusal?: string;
  readonly labelControls: Record<string, string[]>;
}

/** That no Batch came of this try: an earlier try may have made one. */
function noBatchWords(mayHaveBatch: boolean) {
  return mayHaveBatch ? "This try did not send the Batch." : "No Batch was created.";
}

/** The sentence that leads to `count` rows stopped by `kind`. */
function leadWords(kind: RowsKind, count: number, mayHaveBatch: boolean) {
  const jobs = `${formatCount(count)} ${plural(count, "job", "jobs")}`;
  const files = `${formatCount(count)} ${plural(count, "file", "files")}`;
  const words: Record<RowsKind, string> = {
    "cannot be sent": `${jobs} cannot be sent.`,
    refused: `${jobs} ${plural(count, "was", "were")} refused.`,
    unreadable: `${files} could not be read, so nothing was sent.`,
    "not uploaded": `${files} ${plural(count, "was", "were")} not uploaded. ${noBatchWords(mayHaveBatch)}`,
  };
  return words[kind];
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

function SubmitBatch() {
  const router = useRouter();
  const client = useQueryClient();
  const limits = useJobLimits();
  let nextRow = 0;
  const [rows, setRows] = createSignal<readonly DraftRow[]>([]);
  // The form is the one source of what is typed; the page keeps its last reading for the figures and
  // the Custom ID checks, read once per committed change: a field left (the form's `change`), rows
  // or Labels added or removed, and Submit. A keystroke reads nothing.
  const [read, setRead] = createSignal<DraftReading>();
  const jobs = () => read()?.draft.jobs ?? [];
  const repeated = createMemo(() => {
    const listed = rows();
    return new Map(
      [...repeatedCustomIds(jobs())].flatMap(([index, message]) => {
        const row = listed[index];
        return row ? [[row.key, message] as const] : [];
      }),
    );
  });
  const facts = createMemo(() => {
    const reading = read();
    return reading && draftFacts(reading.draft, limits.held());
  });
  const [breakerOn, setBreakerOn] = createSignal(true);
  const [ending, setEnding] = createSignal<Ending>(NO_ENDING);
  // Optimistic, as the form's pending state is: a send is one action, whose other writes show once
  // it settles, while its progress must show as it goes.
  const [progress, setProgress] = createOptimistic<SendProgress | undefined>(undefined);
  let formElement!: HTMLFormElement;
  let sendController: AbortController | undefined;
  // A send still reading or uploading stops when the page goes.
  onCleanup(() => sendController?.abort());

  const submission = createDraftSubmission(
    () => formElement,
    () => rows().length > 0,
  );

  function breakerOf(form: HTMLFormElement): Creation["breaker"] {
    const on = form.elements.namedItem("breaker");
    if (on instanceof HTMLInputElement && !on.checked) return false;
    return {
      canary: figureIn(form, breakerFields.canary),
      maxFailurePercent: figureIn(form, breakerFields.maxFailurePercent),
    };
  }
  /** Reads the draft from the form into the page's last reading, and returns it. */
  function updateDraft(): DraftReading {
    const data = new FormData(formElement);
    const typedId = fieldText(data, "id");
    const { agent, schemaRefusal } = agentOf(formElement, data);
    const labels = labelsOf(data);
    const reading: DraftReading = {
      draft: {
        id: typedId || MADE_ID_FORM,
        agent,
        labels: labels.labels,
        breaker: breakerOf(formElement),
        jobs: jobsOf(data, rows()),
      },
      typedId,
      schemaRefusal,
      labelControls: labels.controls,
    };
    setRead(reading);
    return reading;
  }
  onSettled(() => {
    updateDraft();
  });

  function clearRefusal(name: string) {
    setEnding((previous) => withoutRefusals(previous, (refused) => refused === name));
  }
  /** Sets the rows, then reads the draft once their fields are in the form. */
  function setDraftRows(next: readonly DraftRow[]) {
    setRows(next);
    flush();
    updateDraft();
    // A refusal of the jobs as a whole is of their count, which stands only while past a limit.
    if (next.length >= 1 && next.length <= MAX_JOBS_PER_REQUEST) clearRefusal("jobs");
  }
  /**
   * Changes the rows' refusals by `update`, which says whether it changed any. Otherwise the ending
   * stays as it was: a new value would make every row read its refusal again, at each keystroke.
   */
  function setRowRefusals(update: (rows: Map<number, RowRefusal>) => boolean) {
    setEnding((previous) => {
      const next = new Map(previous.rows);
      return update(next) ? { ...previous, rows: next } : previous;
    });
  }

  const { pending, onSubmit } = createFormAction(async function* () {
    submission.sending();
    // Read here too: Enter can submit before a field's change.
    const reading = updateDraft();
    const id = submission.takeId(reading.typedId);
    if (reading.schemaRefusal) {
      setEnding({
        ...NO_ENDING,
        fields: new Map([[agentFields.outputSchema, reading.schemaRefusal]]),
      });
      return;
    }
    const draft: BatchDraft = { ...reading.draft, id };
    const placed = { ...controls, ...reading.labelControls };
    const sent = rows();
    const keyOf = (index: number) => sent[index]?.key ?? -1;
    sendController = new AbortController();
    let outcome: SendOutcome;
    try {
      outcome = yield* sendBatch(draft, {
        signal: sendController.signal,
        onProgress: (step) => {
          setProgress(step);
          if (step.step === "creating") submission.creating();
        },
      });
    } finally {
      sendController = undefined;
      setProgress(undefined);
    }
    function refusedBy(issues: readonly unknown[], kind: RowsKind): Ending {
      const { atRows, rest } = splitRowIssues(issues, sent);
      const refusal = issuesRefusal(rest, placed);
      return {
        fields: refusal.fields,
        rows: atRows,
        kind,
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
        if (submission.markSucceeded(id))
          await router.navigate({ to: "/batches/$id", params: { id: batch.id } });
        else setEnding(NO_ENDING);
        return;
      }
      case "stopped":
        setEnding({ ...NO_ENDING, stopped: true });
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
          kind: "unreadable",
        });
        return;
      case "invalid":
        // The page's own check: nothing was sent, so its rows cannot be sent rather than refused.
        setEnding(refusedBy(outcome.issues, "cannot be sent"));
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
          kind: "not uploaded",
        });
        return;
      case "createFailed": {
        const { error } = outcome;
        submission.markFailed(error, id);
        if (error instanceof ORPCError && Array.isArray(error.data?.issues))
          setEnding(refusedBy(error.data.issues, "refused"));
        else setEnding({ ...NO_ENDING, alert: [hubFailureMessage(error)] });
        return;
      }
    }
  });

  // The previous ending belongs to the last attempt while the next one is pending.
  const shown = () => (pending() ? NO_ENDING : ending());
  const refused = (name: string) => shown().fields.get(name);
  const mayHaveBatch = () => submission.earlier() !== undefined;
  /**
   * The rows whose words stand now, by what stops them, each at the part that carries its words: a
   * refusal of the last send that no edit has ended, and, once a send has ended, what a row has told
   * since it was added. Empty before any send ends, as each row tells its own then.
   */
  const standing = () => {
    const end = shown();
    if (end === NO_ENDING) return [];
    const byKind = new Map<RowsKind, RowTarget[]>();
    const add = (kind: RowsKind, target: RowTarget) => {
      const targets = byKind.get(kind) ?? [];
      targets.push(target);
      byKind.set(kind, targets);
    };
    for (const row of rows()) {
      const refusal = end.rows.get(row.key);
      const part = refusal?.file
        ? "file"
        : refusal?.input
          ? "input"
          : refusal?.customId && "customId";
      if (part && end.kind) add(end.kind, { key: row.key, part });
      else if (repeated().has(row.key)) add("cannot be sent", { key: row.key, part: "customId" });
      else if (row.problems.length) add("cannot be sent", { key: row.key, part: "file" });
    }
    return ROWS_KINDS.flatMap((kind) => {
      const targets = byKind.get(kind);
      return targets ? [{ kind, targets }] : [];
    });
  };
  // Derived from what stands, so an edit, an addition or a removal changes the counts and links.
  const alert = () => {
    if (pending()) return undefined;
    const groups = standing();
    const after = ending().alert ?? [];
    const earlier = submission.earlier();
    if (!groups.length && !after.length && !earlier) return undefined;
    return { groups, after, earlier };
  };
  const rowNumber = (key: number) => rows().findIndex((row) => row.key === key) + 1;

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
          if (control.name === "id") submission.idEdited(control.value);
          clearRefusal(control.name);
        }}
        onChange={() => {
          updateDraft();
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
            updateDraft();
            setEnding((previous) => withoutRefusals(previous, isLabelsControl));
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
          jobs={jobs()}
          repeated={repeated()}
          refusals={shown().rows}
          error={refused("jobs")}
          pending={pending()}
          mayHaveBatch={mayHaveBatch()}
          after="submit-facts"
          hint={
            <>
              Each job runs the agent once. A job from a file gives the agent that file in its{" "}
              <code>inputs</code> folder and no input of its own, so Instructions must say what to
              do with it. A typed job gives it the text you type. For more jobs than this page
              takes, use the CLI: <code>elflodge batches submit</code>
            </>
          }
          onAdd={(added) => {
            setDraftRows([
              ...rows(),
              ...added.map((job): DraftRow =>
                job.kind === "file"
                  ? {
                      key: nextRow++,
                      kind: "file",
                      customId: job.customId,
                      file: job.file,
                      problems: fileProblems(job.file),
                    }
                  : { key: nextRow++, kind: "typed", customId: job.customId, problems: [] },
              ),
            ]);
          }}
          onRemove={(which) => {
            setDraftRows(which === "all" ? [] : rows().filter((row) => row.key !== which));
            setRowRefusals((refusals) => {
              if (which !== "all") return refusals.delete(which);
              const any = refusals.size > 0;
              refusals.clear();
              return any;
            });
          }}
          onEdited={(key, part) => {
            setRowRefusals((refusals) => {
              const refusal = refusals.get(key);
              if (!refusal?.[part]) return false;
              refusals.set(key, { ...refusal, [part]: undefined });
              return true;
            });
          }}
        />
        <Show when={facts()}>
          {(known) => <Facts facts={known()} limitsFailed={limits.failed()} />}
        </Show>
        <Show when={shown().stopped}>
          <Notice role="status">
            Stopped. {noBatchWords(mayHaveBatch())} {AGAIN}
          </Notice>
        </Show>
        <Show when={alert()}>
          {(words) => (
            <Notice role="alert">
              <For each={words().groups}>
                {(group, index) => (
                  <>
                    {index() > 0 ? "\n" : ""}
                    {`${leadWords(group.kind, group.targets.length, mayHaveBatch())} ${plural(group.targets.length, "It says", "Each says")} why at its row: `}
                    <RowLinks targets={group.targets} numberOf={rowNumber} />
                    {/* Said only while a row it concerns stands. */}
                    {group.kind === "not uploaded" ? `\n${AGAIN}` : ""}
                  </>
                )}
              </For>
              <Show when={words().after.length}>
                {words().groups.length ? "\n" : ""}
                <AlertWords parts={words().after} mayHaveBatch={mayHaveBatch()} />
              </Show>
              <Show when={words().earlier}>
                {(earlier) => (
                  <>
                    {words().groups.length || words().after.length ? "\n" : ""}
                    <EarlierWords
                      earlier={earlier()}
                      record="Batch"
                      records="Batches"
                      link={(id) => (
                        <Link to="/batches/$id" params={{ id }}>
                          {id}
                        </Link>
                      )}
                      // A create repeated under an existing Batch ID returns that Batch for the
                      // same agent, Labels and breaker, and refuses others at the Batch ID. The hub
                      // knows a job by its Custom ID: the same content returns the job, other
                      // content is refused at that Custom ID, a new Custom ID adds a job, and a job
                      // left out stays. So a row renamed here becomes a second job while the first
                      // stays. One conflict refuses the whole request, which then adds no job.
                      repeat={(link) => (
                        <>
                          The hub may already have a Batch under this Batch ID: {link}. Submit again
                          to find out: the same values return that Batch. If it was made, a change
                          here does not edit it: a changed field is refused at Batch ID, a changed
                          job at its Custom ID, and the Batch keeps every job it has and takes any
                          job with a new Custom ID. To submit this as another Batch, change the
                          Batch ID or clear it.
                        </>
                      )}
                    />
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
      <Show when={submission.blocker().status === "blocked"}>
        <LeaveDialog
          submission={submission}
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

/** The words for each step a send shows. */
const stepWords: Record<SendProgress["step"], string> = {
  reading: "Reading the files",
  uploading: "Uploading the files the hub does not hold",
  creating: "Creating the Batch…",
};

/** What the form is doing while it sends: the step, how far, and the figures. */
function Sending(props: { progress: SendProgress | undefined }) {
  const reading = () => (props.progress?.step === "reading" ? props.progress : undefined);
  // Its figures come once the hub has said which contents it holds.
  const uploading = () =>
    props.progress?.step === "uploading" ? props.progress.figures : undefined;
  const words = () => (props.progress ? stepWords[props.progress.step] : "");
  return (
    <div class={words() ? "sending" : undefined}>
      <p role="status" class={words() ? "note" : "vh"}>
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
