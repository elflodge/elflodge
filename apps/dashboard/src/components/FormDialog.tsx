import type { JSX } from "@solidjs/web";
import { Button } from "@ui-sdk/solid/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  type DialogController,
} from "@ui-sdk/solid/dialog";
import { Show, createSignal, onCleanup, onFlush, untrack } from "solid-js";

import { hubWriteFailureMessage, isWriteRefusal } from "../api-client.ts";
import {
  createFormAction,
  formRefusal,
  settledRef,
  withoutRefusals,
  type FormRefusal,
} from "../form.ts";
import { untilFlushed } from "../query.ts";
import { dialogAction, withdrawalMessage } from "./dialog-action.ts";
import { Notice } from "./Notice.tsx";

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

type FormDialogProps<A, T> = {
  controller: DialogController<T>;
  heading: (payload: T) => JSX.Element;
  /** The words of the button that sends, which name what it does. */
  confirm: string;
  dismissLabel?: string;
  /** As wide as the dialog can be, for a form with groups of choices. */
  wide?: boolean;
  /** Places a 4xx refusal at named controls or in the alert. Defaults to the hub's words. */
  refusal?: (error: unknown) => FormRefusal | undefined;
  /**
   * Why the form no longer applies, read live: a read can take it away while the dialog is open. The
   * dialog says it above the fields, and the button that sends does nothing.
   */
  withdrawn?: (payload: T) => string | undefined;
  children: (fields: FormDialogFields, payload: T) => JSX.Element;
} & (
  | {
      send: (form: HTMLFormElement, payload: T) => Promise<A>;
      answer: {
        heading: (answer: A) => JSX.Element;
        children: (answer: A, focus: FormDialogAnswerFocus) => JSX.Element;
      };
      notice?: undefined;
    }
  | {
      /** Resolves once the page shows the outcome, or false when there was nothing to send. */
      send: (form: HTMLFormElement, payload: T) => Promise<void | false>;
      answer?: undefined;
      /** The page's notice of the outcome, for focus once `send` has reported an outcome. */
      notice: () => HTMLElement | undefined;
    }
);

/**
 * A dialog whose form sends a write to the hub, UI SDK's Dialog: a focused task over the page.
 * Its fields sit below the heading. The footer has a dismissing button (Cancel by default) and
 * the button that sends, named by `confirm`. The browser validates the ordinary form before
 * `createFormAction` calls `send` to make the request.
 *
 * Once sent, the dialog cannot be left by its own means until `send` settles. Escape and the
 * dismissing button do nothing, another press or Enter sends nothing more, and focus stays where
 * it was. Leaving the page still leaves it. The caller makes its text fields read-only from
 * `fields.pending`. A press outside it leaves it open. The caller can place a 4xx refusal at a
 * named field or fieldset.
 * Editing it clears its refusal. Other failures say the write may have been done.
 *
 * A list shares one dialog outside every `Show` a read can switch. Each trigger passes the
 * record as its payload. An open dialog keeps that record even if a second trigger is pressed.
 *
 * An answer replaces the fields and has its own heading and Done. Its Copy button takes focus,
 * described by the caller's note because a changed heading alone is not announced. A form with
 * a page notice closes with focus on that notice. Returning false for an unchanged form closes
 * it with the usual focus return to its trigger.
 */
export function FormDialog<A, T = undefined>(props: FormDialogProps<A, T>) {
  // The open dialog's own send, which writes its answer or refusal: see `OpenForm`.
  let sendOpen: ((form: HTMLFormElement) => Promise<void>) | undefined;
  const { pending, onSubmit } = createFormAction(async (form) => {
    await sendOpen?.(form);
  });
  const { root, finalFocus } = dialogAction(props);
  return (
    <Dialog
      controller={props.controller}
      // An answer that came after a dismissal would be shown nowhere, as a new key would, and a form
      // opened again could send the same write twice. Each awaited request needs its own deadline.
      dismissible={!pending()}
      closeOnOutsidePress={false}
      {...root}
    >
      <DialogContent<T> class={props.wide ? "is-wide" : undefined} finalFocus={finalFocus}>
        {(state) => (
          <OpenForm
            {...props}
            // Taken as the content is built: the dialog refuses a change while open, and its content
            // goes when it closes.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- UI SDK types the payload as possibly absent, since a controller can open a dialog without one; a dialog with a payload type is opened by triggers that give one
            payload={state.payload as T}
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
        )}
      </DialogContent>
    </Dialog>
  );
}

function OpenForm<A, T>(
  props: FormDialogProps<A, T> & {
    payload: T;
    pending: () => boolean;
    onSubmit: (event: SubmitEvent & { currentTarget: HTMLFormElement }) => Promise<void>;
    register: (send: (form: HTMLFormElement) => Promise<void>) => void;
  },
) {
  const payload = untrack(() => props.payload);
  // UI SDK removes this content when the dialog closes. Reopening starts a fresh form, and a
  // key shown only once stays out of the controller's payload, announcements and the query cache.
  const [answer, setAnswer] = createSignal<{ value: A }>();
  const [refusal, setRefusal] = createSignal<FormRefusal>();
  const withdrawn = () => props.withdrawn?.(payload);

  props.register(async (form) => {
    // On its own: a write in the action before the request would be held until it settles.
    onFlush(() => setRefusal(undefined));
    // Let the dialog lock before a caller starts a Solid Query mutation in its own action.
    await untilFlushed();
    try {
      if (props.answer) {
        const value = await props.send(form, payload);
        setAnswer({ value });
      } else {
        const outcome = await props.send(form, payload);
        // The reason "action" is what `dialogAction` takes for an outcome the page's notice shows.
        props.controller.close(outcome === false ? undefined : { reason: "action" });
      }
    } catch (error) {
      setRefusal(
        isWriteRefusal(error)
          ? (props.refusal?.(error) ?? formRefusal(error, {}))
          : { fields: new Map(), alert: hubWriteFailureMessage(error) },
      );
    }
  });

  // The form and the title stay through the swap to the answer, which happens inside them: with a
  // `Show` at the top of the content, its swap built the content again, a new answer state with it.
  return (
    <form
      onSubmit={props.onSubmit}
      onInput={({ target, currentTarget }) => {
        if (!(target instanceof Element)) return;
        setRefusal(
          (current) =>
            current &&
            withoutRefusals(current, (name) => {
              const control = currentTarget.elements.namedItem(name);
              return control instanceof Element && control.contains(target);
            }),
        );
      }}
    >
      <DialogTitle class="dialog-h">
        <Show when={answer()} keyed fallback={props.heading(payload)}>
          {(shown) => props.answer?.heading(shown.value)}
        </Show>
      </DialogTitle>
      <Show
        when={answer()}
        keyed
        fallback={
          <>
            <div class="dialog-b">
              <Show when={props.withdrawn}>
                {/* The sentence is rendered text a read changes, so its own element is the live
                    region, there from the start, as ConfirmDialog's explanation is. Off while the hub
                    answers: its own answer changes the record. */}
                <div class="withdrawal" aria-live={props.pending() ? "off" : "polite"}>
                  <Show when={withdrawalMessage(withdrawn(), refusal()?.alert)} keyed>
                    {(reason) => <p>{reason}</p>}
                  </Show>
                </div>
              </Show>
              {props.children(
                {
                  pending: props.pending,
                  refused: (name) => refusal()?.fields.get(name),
                },
                payload,
              )}
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
                    {props.dismissLabel ?? "Cancel"}
                  </Button>
                )}
              />
              {/* Disabled with focusableWhenDisabled, as UI SDK's Button page says of an async
                  submit handler, so it keeps the focus while the hub answers, or a read withdraws the
                  form; it also refuses the press that Enter in a field makes on it. */}
              <Button
                type="submit"
                class="primary"
                disabled={props.pending() || !!withdrawn()}
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
              {props.answer?.children(shown.value, {
                buttonRef: settledRef((button: HTMLButtonElement) => button.focus()),
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
