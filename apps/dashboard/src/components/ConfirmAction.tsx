import type { JSX } from "@solidjs/web";
import { Show, createEffect, createSignal, createUniqueId, flush } from "solid-js";

import { focusIfLost } from "../form.ts";
import { Notice } from "./Notice.tsx";

/**
 * A destructive control and the dialog that confirms it: the button opens the dialog, which says
 * what the action ends and whether that is final, and acts only on its confirming button, which names
 * what it acts on. The safe action comes first and has focus, so a stray Enter keeps. `act` gives the
 * words of a refusal or failure for the open dialog. The page reports it if the member dismissed
 * the dialog. If a fresh roster removes the action, the caller closes the dialog and reports the
 * refusal beside the roster.
 */
export function ConfirmAction(props: {
  /** The words on the button that opens the dialog, such as "Remove". */
  trigger: string;
  /** Disable the trigger while another control is acting on the same record. */
  disabled?: boolean;
  /** An open dialog can outlive the record state that allowed the action. */
  canConfirm?: boolean;
  /** The ID of the visible note explaining the trigger’s consequence. */
  describedBy?: string;
  /** A poll can withdraw the button independently of an open dialog. */
  showTrigger?: boolean;
  /** Restore focus on the page if the original trigger has gone. */
  onClose?: () => void;
  /** The button's whole name, which starts with its words and names what it acts on. */
  triggerLabel: string;
  heading: JSX.Element;
  /** The confirming button's words, which name what it acts on. */
  confirm: string;
  /** The safe action’s words, such as "Keep them" or "Stay". Defaults to "Keep it". */
  keep?: string;
  /** What the action ends, and whether that is final. */
  children: JSX.Element;
  /** `close` returns true if it closed an open, connected dialog and the caller can move focus. */
  act: (close: () => boolean) => Promise<string | undefined>;
  reportPageFailure: (message: string) => void;
}) {
  let dialog: HTMLDialogElement | undefined;
  let keepButton: HTMLButtonElement | undefined;
  let confirmButton: HTMLButtonElement | undefined;
  const headingId = createUniqueId();
  const [pending, setPending] = createSignal(false);
  const [failure, setFailure] = createSignal<string>();

  // A poll can disable the focused confirm button while the dialog is still open.
  createEffect(
    () => props.canConfirm,
    (available) => {
      if (available !== false || !dialog?.open) return;
      if (document.activeElement === confirmButton) keepButton?.focus();
      else focusIfLost(keepButton);
    },
  );

  async function confirm() {
    setPending(true);
    setFailure(undefined);
    let message;
    try {
      message = await props.act(() => {
        const open = Boolean(dialog?.open && dialog.isConnected);
        dialog?.close();
        return open;
      });
    } finally {
      setPending(false);
    }
    if (!message) dialog?.close();
    else if (dialog?.open && dialog.isConnected) {
      setFailure(message);
      // Re-enable the confirming button before restoring focus if disabling it lost focus.
      flush();
      focusIfLost(confirmButton);
    } else props.reportPageFailure(message);
  }

  return (
    <>
      <Show when={props.showTrigger !== false}>
        <button
          type="button"
          class="danger"
          aria-label={props.triggerLabel}
          aria-describedby={props.describedBy}
          disabled={props.disabled}
          onClick={() => {
            setFailure(undefined);
            // Clear the previous refusal before the browser opens and announces the dialog.
            flush();
            dialog?.showModal();
          }}
        >
          {props.trigger}
        </button>
      </Show>
      <dialog
        onClose={() => props.onClose?.()}
        aria-labelledby={headingId}
        ref={(element) => {
          dialog = element;
        }}
      >
        <form method="dialog">
          <h2 class="dialog-h" id={headingId}>
            {props.heading}
          </h2>
          <div class="dialog-b">
            {props.children}
            <p role="status" class={pending() ? "note" : "vh"}>
              {pending() ? "Working…" : ""}
            </p>
            <Show when={failure()} keyed>
              {(message) => <Notice role="alert">{message}</Notice>}
            </Show>
          </div>
          <div class="dialog-f">
            <button
              value="keep"
              autofocus
              ref={(element) => {
                keepButton = element;
              }}
            >
              {pending() ? "Close" : (props.keep ?? "Keep it")}
            </button>
            <button
              type="button"
              class="danger is-fill"
              ref={(element) => {
                confirmButton = element;
              }}
              disabled={pending() || props.canConfirm === false}
              onClick={() => void confirm()}
            >
              {props.confirm}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
