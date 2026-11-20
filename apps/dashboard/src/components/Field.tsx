import type { JSX } from "@solidjs/web";
import { Show, createMemo, createUniqueId, flatten, omit } from "solid-js";

import { FieldError } from "./FieldError.tsx";

type FieldProps = {
  label: JSX.Element;
  unit?: string;
  hint?: JSX.Element;
  error?: string;
};

type FieldControl = {
  readonly id: string;
  readonly "aria-invalid": "true" | undefined;
  readonly "aria-describedby": string | undefined;
};

function fieldParts(props: FieldProps) {
  const id = createUniqueId();
  // Conditional JSX can be an accessor even when it renders nothing.
  const hint = createMemo<JSX.Element[]>(() => flatten([props.hint], { skipNonRendered: true }));
  const hintId = id + "-hint";
  const errorId = id + "-error";
  return {
    control: {
      id,
      get "aria-invalid"(): "true" | undefined {
        return props.error ? "true" : undefined;
      },
      get "aria-describedby"() {
        return (
          [hint().length && hintId, props.error && errorId].filter(Boolean).join(" ") || undefined
        );
      },
    },
    hint: () => (
      <Show when={hint().length}>
        <p id={hintId} class="note">
          {hint()}
        </p>
      </Show>
    ),
    refusal: () => (
      <Show when={props.error}>{(words) => <FieldError id={errorId}>{words()}</FieldError>}</Show>
    ),
  };
}

export function Field(
  props: FieldProps & {
    class?: "field" | "filter-field";
    children: (control: FieldControl) => JSX.Element;
  },
) {
  const { control, hint, refusal } = fieldParts(props);
  return (
    <div class={props.class ?? "field"}>
      <label for={control.id}>
        {props.label}
        <Show when={props.unit}>
          {(unit) => (
            <>
              {" "}
              <span class="unit">{unit()}</span>
            </>
          )}
        </Show>
      </label>
      {hint()}
      {props.children(control)}
      {refusal()}
    </div>
  );
}

export function FieldGroup(
  props: Omit<FieldProps, "unit"> &
    Omit<JSX.FieldsetHTMLAttributes<HTMLFieldSetElement>, "class" | "tabindex"> & {
      children: JSX.Element;
    },
) {
  const { control, hint, refusal } = fieldParts(props);
  return (
    <fieldset
      {...omit(props, "label", "hint", "error", "children")}
      {...omit(control, "id")}
      class="field"
      tabindex="-1"
    >
      <legend>{props.label}</legend>
      {hint()}
      {props.children}
      {refusal()}
    </fieldset>
  );
}
