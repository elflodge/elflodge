import type { JSX } from "@solidjs/web";

/** The mark and words inside a refusal paragraph. */
export function FieldError(props: { children: JSX.Element }) {
  return (
    <>
      <span class="mark mark-error" aria-hidden="true" />
      <span>{props.children}</span>
    </>
  );
}
