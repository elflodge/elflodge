import { ORPCError } from "@orpc/client";
import { noop, useQuery, useQueryClient } from "@tanstack/solid-query";
import { createFileRoute, useBlocker, useRouter } from "@tanstack/solid-router";
import { BATCH_ID_PATTERN, asError, batchCreationSchema, problemOf } from "contract";
import { Show, createSignal, createUniqueId, onSettled } from "solid-js";
// Not crypto.randomUUID, which is undefined outside a secure context: the dashboard may be served
// over plain HTTP on a private network.
import { v4 as uuid } from "uuid";

import { api } from "../../../api-client.ts";
import { Field } from "../../../components/Field.tsx";
import { Notice } from "../../../components/Notice.tsx";
import { RecordCrumbs } from "../../../components/RecordCrumbs.tsx";
import { createFormAction, fieldText, formRefusal } from "../../../form.ts";
import { USD_THRESHOLD, duration, formatCount } from "../../../format.ts";
import { isLeavingDocument } from "../../../member-document.ts";
import { orpc } from "../../../query.ts";

// Under /jobs/, where the bar marks Jobs: job IDs are UUIDs, so "new" cannot name a job.
export const Route = createFileRoute("/_signed-in/_member/jobs_/new")({
  loader: ({ context }) => {
    // Not awaited: the form works without the limits, which only fill two hints. Preloading on
    // intent starts the read before the page shows.
    if (context.member)
      void context.queryClient
        .query(orpc.jobs.limits.queryOptions({ staleTime: "static" }))
        .catch(noop);
  },
  component: SubmitJob,
});

const startingSchema = `{
  "type": "object",
  "properties": {
    "answer": { "type": "string" }
  },
  "required": ["answer"]
}`;

const instructionsField = "agent[instructions]";
const outputSchemaField = "agent[outputContract][schema]";
const budgetField = "agent[modelBudgetUsd]";
const timeoutField = "agent[runTimeoutSeconds]";

// The two IDs name the same submission. Both the hub and the contract's check locate a bad Output
// schema at the schema itself. Other locators have no control and stay in the form alert.
const controls = {
  id: ["id", "jobs[0][customId]"],
  input: ["jobs[0][input]"],
  [instructionsField]: [instructionsField],
  [outputSchemaField]: [outputSchemaField],
  [budgetField]: [budgetField],
  [timeoutField]: [timeoutField],
};

function formatSeconds(value: number) {
  return `${formatCount(value)} (${duration(value)})`;
}

function isTextControl(control: unknown) {
  return control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement;
}

/**
 * The figure a number control holds, read as the browser reads it, so every spelling it accepts,
 * such as `.5` or `1e3`, counts. Empty is NaN: the browser refuses to submit other text.
 */
function figureIn(control: HTMLInputElement) {
  return Number.isNaN(control.valueAsNumber) ? undefined : control.valueAsNumber;
}

function SubmitJob() {
  const router = useRouter();
  const client = useQueryClient();
  const limits = useQuery(() => orpc.jobs.limits.queryOptions());
  // The figures last read, kept through a failed background read. Reading `data` before the first
  // answer would suspend the page, which must not wait for the limits.
  const heldLimits = () => (limits.dataUpdatedAt ? limits.data : undefined);
  function limitHint(
    limit: { default: number; max: number } | undefined,
    format: (value: number) => string,
  ) {
    if (limit)
      return `Left empty: ${format(limit.default)}, the hub’s default. At most ${format(limit.max)}.`;
    return limits.isError
      ? "Left empty, the hub’s default applies; the hub’s limits could not be read."
      : "Left empty, the hub’s default applies.";
  }
  const [failure, setFailure] = createSignal<ReturnType<typeof formRefusal>>();
  // Kept so that a retry after a lost answer sends the same ID, and the hub answers with the job
  // it made instead of making a second one.
  let madeId: string | undefined;
  // A request was sent since the last change and got no answer that says what the hub did. A
  // later refusal of the same draft says nothing of that request, so only an edit or a success
  // settles it.
  const [outcomeUnknown, setOutcomeUnknown] = createSignal(false);
  let submitted = false;
  // The member confirmed leaving while this request was pending: its answer must not take them
  // back. A new send clears it, as a member who came back before leaving sends anew.
  let leaveConfirmed = false;
  let formElement: HTMLFormElement | undefined;
  let budgetInput!: HTMLInputElement;
  let timeoutInput!: HTMLInputElement;
  const dirty = () =>
    !submitted &&
    Array.from(formElement?.elements ?? []).some(
      (control) =>
        isTextControl(control) &&
        (control.value !== control.defaultValue || control.validity.badInput),
    );
  const blocker = useBlocker({
    // A change of fragment alone, such as the skip link's, does not leave the page.
    shouldBlockFn: ({ current, next }) => current.pathname !== next.pathname && dirty(),
    // A document replaced after a sign-out or a change of member must go (ADR 0046).
    enableBeforeUnload: () => !isLeavingDocument() && dirty(),
    withResolver: true,
  });
  const headingId = createUniqueId();

  const { pending, onSubmit } = createFormAction(async (form) => {
    leaveConfirmed = false;
    const data = new FormData(form);
    let schema: unknown;
    try {
      schema = JSON.parse(fieldText(data, outputSchemaField));
    } catch (error) {
      setFailure({
        fields: new Map([[outputSchemaField, `Not valid JSON: ${asError(error).message}`]]),
        alert: undefined,
      });
      return;
    }
    const id = fieldText(data, "id") || (madeId ??= uuid());
    // Checked here, not by oRPC's RequestValidationPlugin, which would check every dashboard call:
    // the schema's text is parsed first, and the page must know whether anything was sent.
    const checked = batchCreationSchema.safeParse({
      id,
      // As `jobs submit` sends it: a breaker means nothing for one job, which would be its Canary,
      // and would pause the Batch if that job failed. A repeat under the same ID, from the CLI or
      // this page, matches while both send this.
      breaker: false,
      jobs: [{ customId: id, input: fieldText(data, "input") }],
      agent: {
        instructions: fieldText(data, instructionsField) || undefined,
        outputContract: { schema },
        modelBudgetUsd: figureIn(budgetInput),
        runTimeoutSeconds: figureIn(timeoutInput),
      },
    });
    if (!checked.success) {
      setFailure(
        formRefusal(
          new ORPCError("BAD_REQUEST", { data: { issues: checked.error.issues } }),
          controls,
        ),
      );
      return;
    }
    try {
      const result = await api.batches.create(checked.data);
      const first = result.jobs[0];
      if (!first) throw new Error("The hub answered without the submitted job.");
      const job = first.job;
      const queryKey = orpc.jobs.get.queryKey({ input: { id: job.id } });
      await client.cancelQueries({ queryKey, exact: true });
      client.setQueryData(queryKey, job);
      void client.invalidateQueries({ queryKey: orpc.jobs.list.key() });
      void client.invalidateQueries({ queryKey: orpc.jobs.counts.key() });
      void client.invalidateQueries({ queryKey: orpc.batches.list.key() });
      void client.invalidateQueries({ queryKey: orpc.batches.get.queryKey({ input: { id } }) });
      if (form.isConnected && !leaveConfirmed) {
        submitted = true;
        // A navigation held by an open leave dialog gives way, so the member lands on the job.
        blocker().reset?.();
        await router.navigate({ to: "/jobs/$id", params: { id: job.id } });
      }
    } catch (error) {
      const status = problemOf(error)?.status;
      // A refusal commits nothing. A failure of the hub or the connection may follow a commit.
      if (!(status !== undefined && status >= 400 && status < 500)) setOutcomeUnknown(true);
      setFailure(formRefusal(error, controls));
      if (status === 403)
        void router.invalidate({ filter: (match) => match.routeId === "/_signed-in" });
    }
  });

  // The previous refusal belongs to the last attempt while the next request is pending.
  const displayedFailure = () => (pending() ? undefined : failure());
  const refused = (name: string) => displayedFailure()?.fields.get(name);
  const mayHaveJob = () => pending() || outcomeUnknown();

  return (
    <>
      <RecordCrumbs to="/jobs" />
      <div class="head">
        <h1>Submit a job</h1>
      </div>
      <form
        class="fields is-wide"
        ref={(form) => {
          formElement = form;
        }}
        autocomplete="off"
        onSubmit={onSubmit}
        onInput={(event) => {
          madeId = undefined;
          setOutcomeUnknown(false);
          const control = event.target;
          if (!isTextControl(control)) return;
          setFailure((previous) => {
            if (!previous?.fields.has(control.name)) return previous;
            const fields = new Map(previous.fields);
            fields.delete(control.name);
            return { ...previous, fields };
          });
        }}
      >
        <p class="note">
          This submits one job from typed text, as a Batch of one. Input files and Labels need the
          CLI: <code>elflodge batches submit --each</code> gives each job a file,{" "}
          <code>elflodge jobs submit</code> takes Labels.
        </p>
        <Field
          label="Instructions"
          hint="Optional. What the agent is told before the input, after its Runner’s own instructions."
          error={refused(instructionsField)}
        >
          {(control) => (
            <textarea
              {...control}
              name={instructionsField}
              // Four rows: a few sentences.
              rows={4}
              readonly={pending()}
            />
          )}
        </Field>
        <Field label="Input" hint="What the agent works on." error={refused("input")}>
          {(control) => (
            <textarea
              {...control}
              name="input"
              // Eight rows: a short document, such as an invoice's lines and a question about them.
              rows={8}
              required
              readonly={pending()}
            />
          )}
        </Field>
        <Field
          label="Output schema"
          hint="A JSON Schema the job’s Output must match: one value, not a list. A starting schema: one text answer. Replace it with yours."
          error={refused(outputSchemaField)}
        >
          {(control) => (
            <textarea
              {...control}
              class="mono"
              name={outputSchemaField}
              // Ten rows: the starting schema's seven lines and a few more properties.
              rows={10}
              required
              spellcheck={false}
              autocapitalize="off"
              readonly={pending()}
              defaultValue={startingSchema}
            />
          )}
        </Field>
        <Field
          label="Custom ID"
          hint={
            <>
              Optional. Names the job and its Batch of one: 1 to 100 letters, digits, <code>_</code>{" "}
              and <code>-</code>, not beginning with <code>-</code>. Left empty, one is made.
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
        <Field
          label="Model budget"
          unit="USD, over its life"
          hint={
            <>
              {limitHint(heldLimits()?.modelBudgetUsd, (value) => USD_THRESHOLD.format(value))} A
              model call in progress completes, so the cost can end a little over.
            </>
          }
          error={refused(budgetField)}
        >
          {(control) => (
            <input
              {...control}
              name={budgetField}
              type="number"
              min="0"
              step="any"
              readonly={pending()}
              ref={(element) => {
                budgetInput = element;
              }}
            />
          )}
        </Field>
        <Field
          label="Run timeout"
          unit="seconds, each run"
          hint={limitHint(heldLimits()?.runTimeoutSeconds, formatSeconds)}
          error={refused(timeoutField)}
        >
          {(control) => (
            <input
              {...control}
              name={timeoutField}
              type="number"
              min="1"
              step="1"
              readonly={pending()}
              ref={(element) => {
                timeoutInput = element;
              }}
            />
          )}
        </Field>
        <Show when={displayedFailure()?.alert}>
          {(message) => <Notice role="alert">{message()}</Notice>}
        </Show>
        <button class="primary" type="submit" aria-disabled={pending() ? "true" : undefined}>
          Submit job
        </button>
        <p role="status" class={pending() ? "note" : "vh"}>
          {pending() ? "Working…" : ""}
        </p>
      </form>
      <Show when={blocker().status === "blocked"}>
        <dialog
          aria-labelledby={headingId}
          ref={(element) => {
            onSettled(() => element.showModal());
          }}
          onClose={() => blocker().reset?.()}
        >
          <form method="dialog">
            <h2 class="dialog-h" id={headingId}>
              {mayHaveJob() ? "Leave this page?" : "Leave without submitting?"}
            </h2>
            <div class="dialog-b">
              <p>
                {mayHaveJob()
                  ? "The hub may already have this job: look for it in Jobs before submitting it again."
                  : "The job has not been submitted."}{" "}
                Leaving this page loses what you typed.
              </p>
            </div>
            <div class="dialog-f">
              <button value="keep" autofocus>
                Stay
              </button>
              <button
                type="button"
                class="danger is-fill"
                onClick={() => {
                  leaveConfirmed = true;
                  blocker().proceed?.();
                }}
              >
                Leave the page
              </button>
            </div>
          </form>
        </dialog>
      </Show>
    </>
  );
}
