import type { JSX } from "@solidjs/web";
import { asError } from "contract";

import type { DraftAgent } from "../batch-draft.ts";
import { fieldText } from "../form.ts";
import { USD_THRESHOLD, duration, formatCount } from "../format.ts";
import { useJobLimits } from "../job-limits.ts";
import { Field } from "./Field.tsx";

/** The names of the agent's fields, which are the paths of the creation's input they edit. */
export const agentFields = {
  instructions: "agent[instructions]",
  outputSchema: "agent[outputContract][schema]",
  modelBudgetUsd: "agent[modelBudgetUsd]",
  runTimeoutSeconds: "agent[runTimeoutSeconds]",
} as const;

/**
 * Each agent field, as `formRefusal` takes its controls. Both the hub and the contract's check
 * locate a bad Output schema at the schema itself.
 */
export const agentControls = Object.fromEntries(
  Object.values(agentFields).map((name) => [name, [name]]),
);

const startingSchema = `{
  "type": "object",
  "properties": {
    "answer": { "type": "string" }
  },
  "required": ["answer"]
}`;

/**
 * The figure a number control holds, read as the browser reads it, so every spelling it accepts,
 * such as `.5` or `1e3`, counts. Empty is NaN: the browser refuses to submit other text.
 */
export function figureIn(form: HTMLFormElement, name: string) {
  const control = form.elements.namedItem(name);
  if (!(control instanceof HTMLInputElement) || Number.isNaN(control.valueAsNumber))
    return undefined;
  return control.valueAsNumber;
}

/**
 * The agent `form`'s fields give, with its Output schema parsed. When the schema's text is not JSON,
 * `schemaRefusal` says why, and the agent holds the text as typed, which is what it would send.
 */
export function agentOf(form: HTMLFormElement): {
  agent: DraftAgent;
  schemaRefusal?: string;
} {
  const data = new FormData(form);
  const text = fieldText(data, agentFields.outputSchema);
  let schema: unknown = text;
  let schemaRefusal: string | undefined;
  try {
    schema = JSON.parse(text);
  } catch (error) {
    schemaRefusal = `Not valid JSON: ${asError(error).message}`;
  }
  return {
    agent: {
      instructions: fieldText(data, agentFields.instructions) || undefined,
      outputContract: { schema },
      modelBudgetUsd: figureIn(form, agentFields.modelBudgetUsd),
      runTimeoutSeconds: figureIn(form, agentFields.runTimeoutSeconds),
    },
    schemaRefusal,
  };
}

function formatSeconds(value: number) {
  return `${formatCount(value)} (${duration(value)})`;
}

/**
 * The agent a job runs, or every job of a Batch: its Instructions, Output schema, Model budget and
 * Run timeout, with the hub's limits in the hints. Submit a job and Submit a Batch send these alike.
 */
export function AgentFields(props: {
  /** Whose agent it is: one job's, or that of each job of a Batch. */
  of: "job" | "Batch";
  pending: boolean;
  /** The refusal of the field `name`, if any. */
  refused: (name: string) => string | undefined;
  /** Fields between Instructions and the Output schema, such as a job's Input. */
  afterInstructions?: JSX.Element;
  /** Fields between the Output schema and the Model budget: the ID. */
  afterSchema: JSX.Element;
}) {
  const limits = useJobLimits();
  function limitHint(
    limit: { default: number; max: number } | undefined,
    format: (value: number) => string,
  ) {
    if (limit)
      return `Left empty: ${format(limit.default)}, the hub’s default. At most ${format(limit.max)}.`;
    return limits.failed()
      ? "Left empty, the hub’s default applies; the hub’s limits could not be read."
      : "Left empty, the hub’s default applies.";
  }
  const each = () => (props.of === "Batch" ? "each job’s" : "the job’s");
  return (
    <>
      <Field
        label="Instructions"
        hint={`Optional. What the agent is told before ${props.of === "Batch" ? "each job’s" : "the"} input, after its Runner’s own instructions.`}
        error={props.refused(agentFields.instructions)}
      >
        {(control) => (
          <textarea
            {...control}
            name={agentFields.instructions}
            // Four rows: a few sentences.
            rows={4}
            readonly={props.pending}
          />
        )}
      </Field>
      {props.afterInstructions}
      <Field
        label="Output schema"
        hint={`A JSON Schema ${each()} Output must match: one value, not a list. A starting schema: one text answer. Replace it with yours.`}
        error={props.refused(agentFields.outputSchema)}
      >
        {(control) => (
          <textarea
            {...control}
            class="mono"
            name={agentFields.outputSchema}
            // Ten rows: the starting schema's seven lines and a few more properties.
            rows={10}
            required
            spellcheck={false}
            autocapitalize="off"
            readonly={props.pending}
            defaultValue={startingSchema}
          />
        )}
      </Field>
      {props.afterSchema}
      <Field
        label="Model budget"
        unit={props.of === "Batch" ? "USD, each job over its life" : "USD, over its life"}
        hint={
          <>
            {limitHint(limits.held()?.modelBudgetUsd, (value) => USD_THRESHOLD.format(value))} A
            model call in progress completes, so the cost can end a little over.
          </>
        }
        error={props.refused(agentFields.modelBudgetUsd)}
      >
        {(control) => (
          <input
            {...control}
            name={agentFields.modelBudgetUsd}
            type="number"
            min="0"
            step="any"
            readonly={props.pending}
          />
        )}
      </Field>
      <Field
        label="Run timeout"
        unit="seconds, each run"
        hint={limitHint(limits.held()?.runTimeoutSeconds, formatSeconds)}
        error={props.refused(agentFields.runTimeoutSeconds)}
      >
        {(control) => (
          <input
            {...control}
            name={agentFields.runTimeoutSeconds}
            type="number"
            min="1"
            step="1"
            readonly={props.pending}
          />
        )}
      </Field>
    </>
  );
}
