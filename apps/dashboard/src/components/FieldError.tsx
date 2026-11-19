import type { JSX } from "@solidjs/web";

/**
 * Why the hub refused what a field holds, under the field. The field names it with
 * `aria-describedby` and is `aria-invalid`, so a screen reader says it with the field.
 */
export function FieldError(props: { id: string; children: JSX.Element }) {
  return (
    <p class="field-error" id={props.id}>
      <span class="mark mark-error" aria-hidden="true" />
      <span>{props.children}</span>
    </p>
  );
}
