import type { JSX } from "@solidjs/web";
import { Button } from "@ui-sdk/solid/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  type DialogController,
} from "@ui-sdk/solid/dialog";
import { Show, createSignal, onCleanup, onFlush, onSettled } from "solid-js";

import { hubWriteFailureMessage, isWriteRefusal } from "../api-client.ts";
import { createFormAction, formRefusal, withoutRefusals } from "../form.ts";
import { Notice } from "./Notice.tsx";

type Refusal = ReturnType<typeof formRefusal>;

/** What the fields need from the dialog that holds them. */
export type FormDialogFields = {
  /** Whether the hub is answering: make text fields `readonly` from it, as the dialog does not. */
  pending: () => boolean;
  /** The hub's words at the control `name` names, for its `Field` or `FieldGroup`. */
  refused: (name: string) => string | undefined;
};

/** How the answer's one control, such as its Copy button, takes focus. */
export type FormDialogAnswerFocus = {
  /** Give it the button that takes focus when the answer shows. */
  buttonRef: (button: HTMLButtonElement) => void;
};

/**
 * A dialog whose form sends a write to the hub, UI SDK's Dialog: a focused task over the page. Its
 * heading, its fields in the body, and in the footer Cancel and the button that sends, named by
 * `confirm`. The form is an ordinary one, sent through `createFormAction` after the browser's own
 * validation, and `send` makes the request.
 *
 * Once sent, the dialog cannot be left by its own means until `send` settles: Escape and Cancel do
 * nothing, another press or Enter sends nothing more, and focus stays where it was. Leaving the
 * page still leaves it. The caller makes its text fields read-only from `fields.pending`. A press
 * outside it never closes it, as with a native modal dialog. A refusal, an answer with a 4xx
 * status, places each of its issues, through `formRefusal`, at the control of `controls` that edits
 * its path, with focus on the refused field, or else in the alert with the hub's words; an edit of
 * that control ends its words. Any other failure may have come after the write was done, whatever
 * issues it carries, so the alert says what a confirmation says then. Opened by a `DialogTrigger`
 * with the same `controller`.
 *
 * `answer` shows what `send` resolved in the same dialog, in place of the form, with its own
 * heading and Done; its button given to `buttonRef` takes focus, which the answer should describe
 * by `aria-describedby`, since a heading changed while focus is in the dialog is not announced.
 */
export function FormDialog<A>(props: {
  controller: DialogController;
  heading: JSX.Element;
  /** The words of the button that sends, which name what it does. */
  confirm: string;
  /** As wide as the dialog can be, for a form with groups of choices. */
  wide?: boolean;
  /** The controls that a refusal can locate, by name, each with the input paths it edits. */
  controls: Record<string, readonly string[]>;
  send: (form: HTMLFormElement) => Promise<A>;
  answer: {
    heading: (answer: A) => JSX.Element;
    children: (answer: A, focus: FormDialogAnswerFocus) => JSX.Element;
  };
  children: (fields: FormDialogFields) => JSX.Element;
}) {
  // The open dialog's own send, which writes its answer or refusal: see `OpenForm`.
  let sendOpen: ((form: HTMLFormElement) => Promise<void>) | undefined;
  const { pending, onSubmit } = createFormAction(async (form) => {
    await sendOpen?.(form);
  });
  return (
    <Dialog
      controller={props.controller}
      // An answer that came after a dismissal would be shown nowhere, as a new key would, and a form
      // opened again could send the same write twice. So every request `send` awaits must end by
      // itself.
      dismissible={!pending()}
      closeOnOutsidePress={false}
      // Beside the page rather than in it, as ConfirmDialog is: UI SDK makes inert what is beside the
      // dialog when it opens, which is then the page's root.
      container={document.body}
    >
      <DialogContent class={props.wide ? "is-wide" : undefined}>
        <OpenForm
          {...props}
          pending={pending}
          onSubmit={onSubmit}
          // Called as the open form is built, so its cleanup is the form's: once the dialog has
          // closed, nothing here keeps the form's send, and with it its answer.
          register={(send) => {
            sendOpen = send;
            onCleanup(() => {
              if (sendOpen === send) sendOpen = undefined;
            });
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function OpenForm<A>(props: {
  heading: JSX.Element;
  confirm: string;
  controls: Record<string, readonly string[]>;
  send: (form: HTMLFormElement) => Promise<A>;
  answer: {
    heading: (answer: A) => JSX.Element;
    children: (answer: A, focus: FormDialogAnswerFocus) => JSX.Element;
  };
  children: (fields: FormDialogFields) => JSX.Element;
  pending: () => boolean;
  onSubmit: (event: SubmitEvent & { currentTarget: HTMLFormElement }) => Promise<void>;
  register: (send: (form: HTMLFormElement) => Promise<void>) => void;
}) {
  // The answer, such as a key the hub shows only once, lives here alone: in the state of the open
  // dialog's content, which UI SDK removes when the dialog closes, so it is gone then. Never in the
  // controller's payload, an announcement or a query's cache.
  const [answer, setAnswer] = createSignal<{ value: A }>();
  const [refusal, setRefusal] = createSignal<Refusal>();

  props.register(async (form) => {
    // On its own: a write in the action before the request would be held until it settles.
    onFlush(() => setRefusal(undefined));
    let value: A;
    try {
      value = await props.send(form);
    } catch (error) {
      // A write that failed without a refusal may have been done, so the alert does not say to try
      // again, nor places issues at fields as if the hub had refused them.
      setRefusal(
        isWriteRefusal(error)
          ? formRefusal(error, props.controls)
          : { fields: new Map(), alert: hubWriteFailureMessage(error) },
      );
      return;
    }
    // Written after the request's await, this takes effect at once, before the action settles.
    setAnswer({ value });
  });

  // The form and the title stay through the swap to the answer, which happens inside them: with a
  // `Show` at the top of the content, its swap built the content again, a new answer state with it.
  return (
    <form
      onSubmit={props.onSubmit}
      onInput={({ target }) => {
        const name = target instanceof Element ? target.getAttribute("name") : null;
        setRefusal((current) =>
          current && name
            ? withoutRefusals(current, (control) => props.controls[control].includes(name))
            : current,
        );
      }}
    >
      <DialogTitle class="dialog-h">
        <Show when={answer()} keyed fallback={props.heading}>
          {(shown) => props.answer.heading(shown.value)}
        </Show>
      </DialogTitle>
      <Show
        when={answer()}
        keyed
        fallback={
          <>
            <div class="dialog-b">
              {props.children({
                pending: props.pending,
                refused: (name) => refusal()?.fields.get(name),
              })}
              {/* In the dialog from the start, so that a screen reader says what is written into it. */}
              <p role="status" class={props.pending() ? "note" : "vh"}>
                {props.pending() ? "Working…" : ""}
              </p>
              <Show when={refusal()?.alert} keyed>
                {(message) => <Notice role="alert">{message}</Notice>}
              </Show>
            </div>
            <div class="dialog-f">
              {/* Marked disabled while the hub answers, and focusable, so a member who moved there
                  stays there. */}
              <DialogClose
                render={(close) => (
                  <Button {...close} disabled={props.pending()} focusableWhenDisabled>
                    Cancel
                  </Button>
                )}
              />
              {/* Disabled with focusableWhenDisabled, as UI SDK's Button page says of an async
                  submit handler, so it keeps the focus while the hub answers. */}
              <Button
                type="submit"
                class="primary"
                disabled={props.pending()}
                focusableWhenDisabled
              >
                {props.confirm}
              </Button>
            </div>
          </>
        }
      >
        {(shown) => (
          <>
            <div class="dialog-b">
              {props.answer.children(shown.value, {
                buttonRef: (button) => onSettled(() => button.focus()),
              })}
            </div>
            <div class="dialog-f">
              <DialogClose>Done</DialogClose>
            </div>
          </>
        )}
      </Show>
    </form>
  );
}
