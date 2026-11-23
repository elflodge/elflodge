import type { JSX } from "@solidjs/web";
import { Field as SDKField, FieldLabel, FieldDescription } from "@ui-sdk/solid/field";
import { Show, createUniqueId, omit } from "solid-js";

import { FieldError } from "./FieldError.tsx";

type FieldProps = {
  /** The words of the label or legend. */
  label: JSX.Element;
  /** The unit printed after the label, such as USD. */
  unit?: string;
  /** One note above the control. Pass undefined when there is no hint. */
  hint?: JSX.Element;
  /** A refusal from the hub or the page. Separate several reasons with a line break. */
  error?: string;
};

type FieldLayout =
  | {
      /** A label above its control. */
      class?: "field";
    }
  | {
      /** A label beside its control in a filters row. */
      class: "filter-field";
      hint?: never;
    };

/** One control under a label. */
export function Field(props: FieldProps & FieldLayout & { children: JSX.Element }) {
  return (
    <SDKField class={props.class ?? "field"} invalid={props.error !== undefined}>
      <FieldLabel>
        {props.label}
        {/* The space sits inside the unit's text: Chromium drops a separate space text node from
            the label's accessible name, which would read "budgetUSD". */}
        <Show when={props.unit}>{(unit) => <span class="unit">{` ${unit()}`}</span>}</Show>
      </FieldLabel>
      {/* Keep the hint registered first when a fresh hub limit changes its words. */}
      <Show when={!!props.hint}>
        <FieldDescription class="note">{props.hint}</FieldDescription>
      </Show>
      {props.children}
      <RefusalDescription error={props.error} />
    </SDKField>
  );
}

// UI SDK's FieldError with match announces only the last of several refusals, without its field's name.
// Use that part when UI SDK can deliver a refusal on focus without a competing announcement.
export function RefusalDescription(props: { error?: string }) {
  return (
    <Show when={props.error} keyed>
      {(words) => (
        <FieldDescription class="field-error">
          <FieldError>{words}</FieldError>
        </FieldDescription>
      )}
    </Show>
  );
}

/**
 * Several controls under a legend. Other attributes go to the focusable fieldset; a `class` is added
 * to its own.
 */
export function FieldGroup(
  props: Omit<FieldProps, "unit"> &
    Omit<JSX.FieldsetHTMLAttributes<HTMLFieldSetElement>, "tabindex"> & {
      /** Derived from the presence of a refusal. */
      "aria-invalid"?: never;
      /** Derived from the hint and refusal. */
      "aria-describedby"?: never;
      /** The controls labeled by the legend. */
      children: JSX.Element;
    },
) {
  // UI SDK's FieldSet has no part for a refusal on the set itself.
  const id = createUniqueId();
  const hintId = id + "-hint";
  const errorId = id + "-error";
  return (
    <fieldset
      {...omit(props, "label", "hint", "error", "children", "class")}
      aria-invalid={props.error !== undefined ? "true" : undefined}
      aria-describedby={
        [props.hint && hintId, props.error && errorId].filter(Boolean).join(" ") || undefined
      }
      class={["field", props.class]}
      tabindex="-1"
    >
      <legend>{props.label}</legend>
      <Show when={props.hint} keyed>
        {(hint) => (
          <p class="note" id={hintId}>
            {hint}
          </p>
        )}
      </Show>
      {props.children}
      <Show when={props.error} keyed>
        {(words) => (
          <p class="field-error" id={errorId}>
            <FieldError>{words}</FieldError>
          </p>
        )}
      </Show>
    </fieldset>
  );
}
