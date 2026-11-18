import type { JSX } from "@solidjs/web";

/**
 * One sentence the reader must not miss: an `alert` says what failed or was refused, a `status`
 * that something was done. Each has its mark as well as its colour.
 */
export function Notice(props: { role: "alert" | "status"; children: JSX.Element }) {
  return (
    <div
      class={props.role === "alert" ? "notice notice-failed" : "notice notice-done"}
      role={props.role}
    >
      <span
        class={props.role === "alert" ? "mark mark-failed" : "mark mark-succeeded"}
        aria-hidden="true"
      />
      <p>{props.children}</p>
    </div>
  );
}
