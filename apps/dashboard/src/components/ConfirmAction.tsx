import type { JSX } from "@solidjs/web";
import { Show, createSignal, createUniqueId, flush } from "solid-js";

import { Notice } from "./Notice.tsx";

/**
 * A destructive control and the dialog that confirms it: the button opens the dialog, which says
 * what the action ends and whether that is final, and acts only on its confirming button, which names
 * what it acts on. "Keep it" is first and has the focus, so a stray Enter keeps. `act` gives the
 * words of a refusal or failure, said in the dialog, at the action; the dialog closes once it is done.
 */
export function ConfirmAction(props: {
  /** The words on the button that opens the dialog, such as "Remove". */
  trigger: string;
  /** The button's whole name, which starts with its words and names what it acts on. */
  triggerLabel: string;
  heading: JSX.Element;
  /** The confirming button's words, which name what it acts on. */
  confirm: string;
  /** What the action ends, and whether that is final. */
  children: JSX.Element;
  act: () => Promise<string | undefined>;
}) {
  let dialog: HTMLDialogElement | undefined;
  const headingId = createUniqueId();
  const [pending, setPending] = createSignal(false);
  const [failure, setFailure] = createSignal<string>();

  async function confirm() {
    setPending(true);
    setFailure(undefined);
    try {
      const message = await props.act();
      if (message) setFailure(message);
      else dialog?.close();
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        class="danger"
        aria-label={props.triggerLabel}
        onClick={() => {
          setFailure(undefined);
          flush();
          dialog?.showModal();
        }}
      >
        {props.trigger}
      </button>
      <dialog
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
            <Show when={failure()}>{(message) => <Notice role="alert">{message()}</Notice>}</Show>
          </div>
          <div class="dialog-f">
            <button value="keep" autofocus>
              Keep it
            </button>
            <button
              type="button"
              class="danger is-fill"
              disabled={pending()}
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
