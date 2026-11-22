import type { JSX } from "@solidjs/web";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  type AlertDialogController,
} from "@ui-sdk/solid/alert-dialog";
import { Show, onFlush } from "solid-js";

import { hubWriteFailureMessage } from "../api-client.ts";
import { Notice } from "./Notice.tsx";

/**
 * The dialog that confirms a destructive action on one of a list's records: it says what the action
 * ends and whether that is final, and acts only on its confirming button, which names what it acts
 * on. The safe choice comes first and has focus, so a stray Enter keeps; opened by touch, the
 * dialog itself has focus, as UI SDK does it.
 *
 * One per list, outside it, opened by an `AlertDialogTrigger` in each row with the same
 * `controller` and the record as its payload. A dialog in the row would go with the row, and with it
 * a refusal still to show; this one stays when a read drops the record, naming it as the member saw
 * it, so the payload carries the record's words as they were at the press.
 *
 * The page reads the list through `latest`, as `createMemo(() => latest(() => deep(query.data)))`,
 * everywhere it reads it: a pass that reads a list being read again under the same key, by a poll
 * or an invalidation, can hold the dialog's writes until that read lands.
 *
 * Once confirmed it cannot be left until `act` settles. `act` resolves once the page shows the
 * outcome, which closes the dialog with focus on `notice`, brought into view; it throws to refuse,
 * and the dialog shows why and keeps focus on the confirming button for a retry.
 */
export function ConfirmDialog<T>(props: {
  controller: AlertDialogController<T>;
  heading: (record: T) => JSX.Element;
  /** The confirming button's words, which name what it acts on. */
  confirm: (record: T) => string;
  /** What the action ends, and whether that is final. */
  children: (record: T) => JSX.Element;
  act: (record: T) => Promise<void>;
  /** The page's notice of the outcome, for focus once `act` has resolved. */
  notice: () => HTMLElement | undefined;
}) {
  // Only an outcome the page shows takes focus: a keep or Escape returns it to the row's button,
  // even with an older notice on the page. A resolved action closes with the reason "action".
  let acted = false;
  return (
    <AlertDialog
      controller={props.controller}
      // Beside the page rather than in it: UI SDK makes inert what is beside the dialog when it opens,
      // which is then the page's root, so what a read renders later is inert too. UI SDK leaves out
      // live regions showing at that moment and what holds them, so with an earlier notice showing,
      // what a read renders later beside it stays exposed.
      container={document.body}
      pendingAnnouncement="Working…"
      onOpenChange={(open, details) => {
        acted = !open && details.reason === "action";
      }}
      onOpenChangeComplete={(open) => {
        // UI SDK focuses without scrolling, and the notice can be above a long list scrolled down.
        if (!open && acted) props.notice()?.scrollIntoView({ block: "nearest" });
      }}
    >
      <AlertDialogContent<T> finalFocus={() => (acted ? props.notice() : undefined)}>
        {(state) => (
          <Show when={state.payload} keyed>
            {(record) => (
              <>
                <AlertDialogTitle class="dialog-h">{props.heading(record)}</AlertDialogTitle>
                <AlertDialogClose
                  value="confirm"
                  action={async () => {
                    // `act` starts a mutation, a Solid action that would hold the part's pending
                    // state, written in this same tick, until the hub answers.
                    await new Promise<void>((resolve) => onFlush(resolve));
                    await props.act(record);
                  }}
                  render={(button, close) => (
                    <>
                      <div class="dialog-b">
                        <AlertDialogDescription render={(description) => <div {...description} />}>
                          {props.children(record)}
                        </AlertDialogDescription>
                        <Show when={close.pending}>
                          <p class="note">Working…</p>
                        </Show>
                        <Show when={close.error} keyed>
                          {(error) => <Notice role="alert">{hubWriteFailureMessage(error)}</Notice>}
                        </Show>
                      </div>
                      <div class="dialog-f">
                        <AlertDialogClose>Keep it</AlertDialogClose>
                        <button {...button} class="danger is-fill">
                          {props.confirm(record)}
                        </button>
                      </div>
                    </>
                  )}
                />
              </>
            )}
          </Show>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
