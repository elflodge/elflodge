import { ORPCError } from "@orpc/client";
import { isSchemaIssue } from "@orpc/contract";
import { useQueryClient } from "@tanstack/solid-query";
import { createFileRoute, useRouter } from "@tanstack/solid-router";
import { BATCH_ID_PATTERN, BREAKER_DEFAULTS } from "contract";
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
import { LabelFields, labelsOf } from "../../../components/LabelFields.tsx";
import { Notice } from "../../../components/Notice.tsx";
import { RecordCrumbs } from "../../../components/RecordCrumbs.tsx";
import { createFormAction, fieldText, formRefusal } from "../../../form.ts";
import { formatBytes } from "../../../format-bytes.ts";
import { USD_BUDGET, formatCount, plural } from "../../../format.ts";
import { preloadJobLimits, useJobLimits } from "../../../job-limits.ts";
import { orpc } from "../../../query.ts";

// "-" is a segment no Batch ID can be, so no Batch's page has this address, and the bar marks
// Batches. The router ignores a file name's leading "-" only, so this one is routed.
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

/** Part of an alert's words: text, the rows to link to by their keys, or a command. */
type AlertPart = string | { readonly rows: readonly number[] } | { readonly code: string };

/** How the last send ended, where the page tells it. */
interface Ending {
  readonly fields: ReadonlyMap<string, string>;
  readonly rows: ReadonlyMap<number, RowRefusal>;
  readonly alert?: readonly AlertPart[];
  readonly stopped?: true;
}

const NO_ENDING: Ending = { fields: new Map(), rows: new Map() };

/** `count` rows, each saying why at its row, after `lead`: "2 jobs were refused." */
function rowsSentence(count: number, lead: string, rows: readonly number[]): AlertPart[] {
  return [`${lead} ${count === 1 ? "It says" : "Each says"} why at its row: `, { rows }];
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
  // and breaker, and refuses others at the Batch ID; it returns a job for the same content
  // under its Custom ID, and refuses other content at that job's Custom ID. A job under a new
  // Custom ID is added to the Batch, and a job left out stays in it: the answer names only the
  // jobs sent. All or nothing, so a refusal adds no job.
  if (sentUnder === "typed ID")
    return "The hub may already have a Batch under this Batch ID. Submit again to find out: the same values return that Batch. If it was made, a changed field or job is refused where it stands, a job added here joins it, and a job removed here stays in it.";
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
  /** The draft the form holds, with the ID it would be sent under. */
  function draftOf(form: HTMLFormElement, id: string): BatchDraft {
    return {
      id,
      agent: agentOf(form).agent,
      labels: labelsOf(form).labels,
      breaker: breakerOf(form),
      jobs: rows(),
    };
  }
  const facts = createMemo(() => {
    edits();
    const form = formElement;
    const draft: BatchDraft = form
      ? draftOf(form, fieldText(new FormData(form), "id") || (submission.madeId() ?? MADE_ID_FORM))
      : { id: MADE_ID_FORM, agent: { outputContract: { schema: {} } }, jobs: rows() };
    return draftFacts(draft, limits.held());
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
    const { agent, schemaRefusal } = agentOf(form);
    if (schemaRefusal) {
      setEnding({ ...NO_ENDING, fields: new Map([[agentFields.outputSchema, schemaRefusal]]) });
      return;
    }
    const labels = labelsOf(form);
    const placed = { ...controls, ...labels.controls };
    const { id, sentUnder } = submission.idFor(fieldText(new FormData(form), "id"));
    const sent = rows();
    const draft: BatchDraft = {
      id,
      agent,
      labels: labels.labels,
      breaker: breakerOf(form),
      jobs: sent,
    };
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
      const keys = [...atRows.keys()];
      return {
        fields: refusal.fields,
        rows: atRows,
        alert: [
          ...(keys.length
            ? rowsSentence(
                keys.length,
                keys.length === 1
                  ? "1 job was refused."
                  : `${formatCount(keys.length)} jobs were refused.`,
                keys,
              )
            : []),
          ...(keys.length && refusal.alert ? ["\n"] : []),
          ...(refusal.alert ? [refusal.alert] : []),
        ],
      };
    }
    switch (outcome.kind) {
      case "created": {
        const { jobs: _jobs, ...batch } = outcome.answer;
        // The answer names each job by its IDs alone, so the Batch's page reads its jobs.
        client.setQueryData(orpc.batches.get.queryKey({ input: { id: batch.id } }), batch);
        void client.invalidateQueries({ queryKey: orpc.jobs.list.key() });
        void client.invalidateQueries({ queryKey: orpc.jobs.counts.key() });
        void client.invalidateQueries({ queryKey: orpc.batches.list.key() });
        if (submission.succeeded(form, sentUnder))
          await router.navigate({ to: "/batches/$id", params: { id: batch.id } });
        else setEnding(NO_ENDING);
        return;
      }
      case "stopped":
        setEnding({ ...NO_ENDING, stopped: true });
        return;
      case "refusedAtAdd": {
        const keys = outcome.indexes.map(keyOf);
        const count = keys.length;
        setEnding({
          ...NO_ENDING,
          alert: rowsSentence(
            count,
            count === 1 ? "1 job cannot be sent." : `${formatCount(count)} jobs cannot be sent.`,
            keys,
          ),
        });
        return;
      }
      case "unreadable": {
        const count = outcome.jobs.length;
        setEnding({
          ...NO_ENDING,
          rows: new Map(
            outcome.jobs.map(({ index, message }) => [
              keyOf(index),
              { file: `The file could not be read: ${message}\nRemove it and add it again.` },
            ]),
          ),
          alert: rowsSentence(
            count,
            `${formatCount(count)} of ${formatCount(outcome.files)} ${plural(outcome.files, "file", "files")} could not be read, so nothing was sent.`,
            outcome.jobs.map(({ index }) => keyOf(index)),
          ),
        });
        return;
      }
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
          alert: [`${hubFailureMessage(outcome.error)}\nNo Batch was created. ${AGAIN}`],
        });
        return;
      case "notUploaded": {
        const count = outcome.jobs.length;
        setEnding({
          ...NO_ENDING,
          rows: new Map(
            outcome.jobs.map(({ index, message }) => [keyOf(index), { file: message }]),
          ),
          alert: [
            ...rowsSentence(
              count,
              `${formatCount(count)} of ${formatCount(outcome.files)} ${plural(outcome.files, "file", "files")} ${count === 1 ? "was" : "were"} not uploaded, so no Batch was created.`,
              outcome.jobs.map(({ index }) => keyOf(index)),
            ),
            `\n${AGAIN}`,
          ],
        });
        return;
      }
      case "createFailed": {
        const { error } = outcome;
        submission.failed(error, sentUnder);
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
  const alert = (): AlertPart[] | undefined => {
    if (pending()) return undefined;
    const parts = [...(ending().alert ?? [])];
    const words = unknownWords(submission.unknownOutcome());
    if (words) parts.push(...(parts.length ? ["\n"] : []), words);
    return parts.length ? parts : undefined;
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
                  Optional. Names the Batch: 1 to 100 letters, digits, <code>_</code> and{" "}
                  <code>-</code>, not beginning with <code>-</code>. Left empty, one is made.
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
              fields: new Map([...previous.fields].filter(([name]) => !name.startsWith("labels"))),
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
        />
        <Facts facts={facts()} limitsFailed={limits.failed()} />
        <Show when={shown().stopped}>
          <Notice role="status">Stopped. No Batch was created. {AGAIN}</Notice>
        </Show>
        <Show when={alert()}>
          {(parts) => (
            <Notice role="alert">
              <AlertWords parts={parts()} numberOf={rowNumber} />
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

/** An alert's words, with its links to rows and its commands. */
function AlertWords(props: { parts: readonly AlertPart[]; numberOf: (key: number) => number }) {
  return (
    <For each={props.parts}>
      {(value) => {
        if (typeof value === "string") return value;
        if ("code" in value) return <code>{value.code}</code>;
        return <RowLinks keys={value.rows} numberOf={props.numberOf} />;
      }}
    </For>
  );
}

/** Links to the rows `keys`, numbered as the list numbers them now: ten, then how many more. */
function RowLinks(props: { keys: readonly number[]; numberOf: (key: number) => number }) {
  // A row removed since is no longer linked.
  const listed = () => props.keys.filter((key) => props.numberOf(key) > 0);
  return (
    <>
      <For each={listed().slice(0, 10)}>
        {(key, index) => (
          <>
            {index() > 0 ? ", " : ""}
            <a
              href={`#${rowControlId(key)}`}
              onClick={(event) => {
                event.preventDefault();
                const field = document.getElementById(rowControlId(key));
                field?.focus();
                field?.scrollIntoView({ block: "center" });
              }}
            >
              {formatCount(props.numberOf(key))}
            </a>
          </>
        )}
      </For>
      {listed().length > 10 ? ` and ${formatCount(listed().length - 10)} more` : ""}
    </>
  );
}

/** A figure beside its limit, past it in the failed colour with the error mark. */
function AgainstLimit(props: { over: boolean; children: string }) {
  return (
    <Show when={props.over} fallback={props.children}>
      <span class="is-over">
        <span class="mark mark-error" aria-hidden="true" />
        {props.children}
      </span>
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
        <AgainstLimit over={jobs().count > jobs().max}>
          {`${formatCount(jobs().count)} of at most ${formatCount(jobs().max)}`}
        </AgainstLimit>
        {jobs().count
          ? `: ${formatCount(jobs().fromFiles)} from files, ${formatCount(jobs().typed)} typed`
          : ""}
      </dd>
      <dt>Text</dt>
      <dd>
        <AgainstLimit over={request().bytes > request().max}>
          {`${formatBytes(request().bytes)} of at most ${formatBytes(request().max)}`}
        </AgainstLimit>
        : everything sent but the files’ contents
      </dd>
      <dt>Files</dt>
      <dd>
        {files().count ? `${formatCount(files().count)}, ${formatBytes(files().bytes)}` : "None"};
        each at most {formatBytes(files().maxEach)}
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
                  `${formatCount(upload().same)} ${plural(upload().same, "has", "have")} the same content as another file here.`,
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
