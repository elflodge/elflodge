import type { JSX } from "@solidjs/web";
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

type FieldControl = {
  readonly id: string;
  readonly "aria-invalid": "true" | undefined;
  readonly "aria-describedby": string | undefined;
};

function fieldParts(props: FieldProps) {
  const id = createUniqueId();
  const hintId = id + "-hint";
  const errorId = id + "-error";
  return {
    control: {
      id,
      get "aria-invalid"(): "true" | undefined {
        return props.error !== undefined ? "true" : undefined;
      },
      get "aria-describedby"() {
        return (
          [props.hint && hintId, props.error && errorId].filter(Boolean).join(" ") || undefined
        );
      },
    },
    hint: () => (
      <Show when={props.hint} keyed>
        {(hint) => (
          <p id={hintId} class="note">
            {hint}
          </p>
        )}
      </Show>
    ),
    refusal: () => (
      <Show when={props.error} keyed>
        {(words) => <FieldError id={errorId}>{words}</FieldError>}
      </Show>
    ),
  };
}

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
export function Field(
  props: FieldProps &
    FieldLayout & {
      /** Spread these attributes on the labeled control. */
      children: (control: FieldControl) => JSX.Element;
    },
) {
  const { control, hint, refusal } = fieldParts(props);
  return (
    <div class={props.class ?? "field"}>
      <label for={control.id}>
        {props.label}
        {/* The space sits inside the unit's text: Chromium drops a separate space text node from
            the label's accessible name, which would read "budgetUSD". */}
        <Show when={props.unit}>{(unit) => <span class="unit">{` ${unit()}`}</span>}</Show>
      </label>
      {hint()}
      {props.children(control)}
      {refusal()}
    </div>
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
  const { control, hint, refusal } = fieldParts(props);
  return (
    <fieldset
      {...omit(props, "label", "hint", "error", "children", "class")}
      {...omit(control, "id")}
      class={["field", props.class]}
      tabindex="-1"
    >
      <legend>{props.label}</legend>
      {hint()}
      {props.children}
      {refusal()}
    </fieldset>
  );
}
