import { ORPCError } from "@orpc/client";
import { JsonSchemaCoercer } from "@orpc/json-schema";
import { useQuery, useQueryClient } from "@tanstack/solid-query";
import { createFileRoute, useBlocker, useRouter } from "@tanstack/solid-router";
import {
  BATCH_ID_PATTERN,
  agentSchema,
  asError,
  batchCreationSchema,
  openOutputSchemaConverter,
  problemOf,
} from "contract";
import { Show, createEffect, createSignal, createUniqueId } from "solid-js";
import { v4 as uuid } from "uuid";

import { api } from "../../../api-client.ts";
import { Field } from "../../../components/Field.tsx";
import { Notice } from "../../../components/Notice.tsx";
import { RecordCrumbs } from "../../../components/RecordCrumbs.tsx";
import { createFormAction, fieldText, formRefusal } from "../../../form.ts";
import { USD_BUDGET, duration, formatCount } from "../../../format.ts";
import { orpc } from "../../../query.ts";

// Keep submission outside /jobs/new and /batches/new: "new" is a valid Batch ID.
export const Route = createFileRoute("/_signed-in/_member/submit/job")({
  loader: ({ context }) => {
    if (context.member) void context.queryClient.prefetchQuery(orpc.jobs.limits.queryOptions());
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

const instructions = "agent[instructions]";
const output = "agent[outputContract][schema]";
const budget = "agent[modelBudgetUsd]";
const timeout = "agent[runTimeoutSeconds]";

// The two IDs name the same submission. Every part of the Output contract is edited as one field.
// Other locators have no control and stay in the form alert.
const controls = {
  id: ["id", "jobs[0][customId]"],
  input: ["jobs[0][input]"],
  [instructions]: [instructions],
  [output]: [{ subtree: "agent[outputContract]" }],
  [budget]: [budget],
  [timeout]: [timeout],
};

// Only numbers come from text. Coercing the already parsed Output schema could turn [] into {}.
const coercer = new JsonSchemaCoercer();
const budgetSchema = openOutputSchemaConverter.convert(agentSchema.shape.modelBudgetUsd, "input");
const timeoutSchema = openOutputSchemaConverter.convert(
  agentSchema.shape.runTimeoutSeconds,
  "input",
);

function seconds(value: number) {
  return `${formatCount(value)} (${duration(value)})`;
}

function SubmitJob() {
  const router = useRouter();
  const client = useQueryClient();
  const limits = useQuery(() => orpc.jobs.limits.queryOptions());
  const figures = () => (!limits.isError && limits.dataUpdatedAt ? limits.data : undefined);
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
  let madeId: string | undefined;
  let submitted = false;
  let element: HTMLFormElement | undefined;
  const dirty = () =>
    !submitted &&
    Array.from(element?.elements ?? []).some(
      (control) =>
        (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) &&
        (control.value !== control.defaultValue || control.validity.badInput),
    );
  const blocker = useBlocker({
    shouldBlockFn: dirty,
    enableBeforeUnload: dirty,
    withResolver: true,
  });
  let dialog: HTMLDialogElement | undefined;
  const heading = createUniqueId();
  createEffect(
    () => blocker().status,
    (status) => {
      if (status === "blocked") dialog?.showModal();
      else dialog?.close();
    },
  );

  const { pending, onSubmit } = createFormAction(async (form) => {
    const data = new FormData(form);
    let schema: unknown;
    try {
      schema = JSON.parse(fieldText(data, output));
    } catch (error) {
      setFailure({
        fields: new Map([[output, `Not valid JSON: ${asError(error).message}`]]),
        alert: undefined,
      });
      return;
    }
    const id = fieldText(data, "id") || (madeId ??= uuid());
    const jobs = [{ customId: id, input: fieldText(data, "input") }];
    const checked = batchCreationSchema.safeParse({
      id,
      breaker: false,
      jobs,
      agent: {
        instructions: fieldText(data, instructions) || undefined,
        outputContract: { schema },
        modelBudgetUsd: coercer.coerce(budgetSchema, fieldText(data, budget) || undefined),
        runTimeoutSeconds: coercer.coerce(timeoutSchema, fieldText(data, timeout) || undefined),
      },
    });
    try {
      if (!checked.success)
        throw new ORPCError("BAD_REQUEST", { data: { issues: checked.error.issues } });
      const result = await api.batches.create({
        id,
        agent: checked.data.agent,
        breaker: false,
        jobs,
      });
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
      if (form.isConnected) {
        submitted = true;
        blocker().reset?.();
        await router.navigate({ to: "/jobs/$id", params: { id: job.id } });
      }
    } catch (error) {
      const refusal = formRefusal(error, controls);
      // While the hub was answering, the member may already have edited a refused value.
      const now = new FormData(form);
      for (const name of refusal.fields.keys())
        if (now.get(name) !== data.get(name)) refusal.fields.delete(name);
      setFailure(refusal);
      if (problemOf(error)?.status === 403)
        void router.invalidate({ filter: (match) => match.routeId === "/_signed-in" });
    }
  });

  // The previous refusal belongs to the last attempt while the next request is pending.
  const displayedFailure = () => (pending() ? undefined : failure());
  const refused = (name: string) => displayedFailure()?.fields.get(name);

  return (
    <>
      <RecordCrumbs to="/jobs" />
      <div class="head">
        <h1>Submit a job</h1>
      </div>
      <form
        class="fields is-wide"
        ref={(form) => {
          element = form;
        }}
        autocomplete="off"
        onSubmit={onSubmit}
        onInput={(event) => {
          madeId = undefined;
          const control = event.target;
          if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement))
            return;
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
          error={refused(instructions)}
        >
          {(control) => <textarea {...control} name={instructions} rows={4} />}
        </Field>
        <Field label="Input" hint="What the agent works on." error={refused("input")}>
          {(control) => <textarea {...control} name="input" rows={8} required />}
        </Field>
        <Field
          label="Output schema"
          hint="A JSON Schema the job’s Output must match: one value, not a list. A starting schema: one text answer. Replace it with yours."
          error={refused(output)}
        >
          {(control) => (
            <textarea
              {...control}
              class="mono"
              name={output}
              rows={10}
              required
              spellcheck={false}
              autocapitalize="off"
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
            />
          )}
        </Field>
        <Field
          label="Model budget"
          unit="USD, over its life"
          hint={
            <>
              {limitHint(figures()?.modelBudgetUsd, (value) => USD_BUDGET.format(value))} A model
              call in progress completes, so the cost can end a little over.
            </>
          }
          error={refused(budget)}
        >
          {(control) => <input {...control} name={budget} type="number" min="0" step="any" />}
        </Field>
        <Field
          label="Run timeout"
          unit="seconds, each run"
          hint={limitHint(figures()?.runTimeoutSeconds, seconds)}
          error={refused(timeout)}
        >
          {(control) => <input {...control} name={timeout} type="number" min="1" step="1" />}
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
      <dialog
        ref={(node) => {
          dialog = node;
        }}
        aria-labelledby={heading}
        onCancel={() => blocker().reset?.()}
      >
        <h2 class="dialog-h" id={heading}>
          Leave without submitting?
        </h2>
        <div class="dialog-b">
          <p>The job has not been submitted. Leaving this page loses what you typed.</p>
        </div>
        <div class="dialog-f">
          <button type="button" autofocus onClick={() => blocker().reset?.()}>
            Stay
          </button>
          <button type="button" class="danger is-fill" onClick={() => blocker().proceed?.()}>
            Leave the page
          </button>
        </div>
      </dialog>
    </>
  );
}
