import type { JSX } from "@solidjs/web";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  type AlertDialogController,
} from "@ui-sdk/solid/alert-dialog";
import { Button } from "@ui-sdk/solid/button";
import { Show, createMemo } from "solid-js";

import { hubWriteFailureMessage, isWriteRefusal } from "../api-client.ts";
import { untilFlushed } from "../query.ts";
import { dialogAction, withdrawalMessage } from "./dialog-action.ts";
import { Notice } from "./Notice.tsx";

/**
 * The dialog that confirms a destructive action on a record: it says what the action ends and
 * whether that is final, and acts only on its confirming button, which names what it acts on. The
 * safe choice comes first and has focus, so a stray Enter keeps; opened by touch, the dialog itself
 * has focus, as UI SDK does it.
 *
 * One per list, outside it, or one for a record's controls, outside every `Show` a read can switch,
 * opened by an `AlertDialogTrigger` with the same `controller` and the record, or the control, as its
 * payload. A dialog beside its trigger would go with it, and with it a refusal still to show; this
 * one stays when a read drops the record or withdraws the control, naming it as the member saw it,
 * so the payload carries the words that change with every read as they were at the press.
 *
 * What the dialog's interaction reads from the list or the record, or makes Solid recompute, the
 * page reads through `latest`, as `createMemo(() => latest(() => deep(query.data)))`: the triggers'
 * payloads and labels, the conditions that show them, what the dialog renders and what `act`
 * recomputes. While a query reads again under the same key, its `data` is pending, and a flush that
 * reruns a derivation of it waits for that read with every write staged in it, the dialog's
 * included.
 *
 * Once confirmed it cannot be left until `act` settles. `act` resolves once the page shows the
 * outcome, which closes the dialog with focus on `notice`, brought into view; it throws to refuse,
 * and the dialog shows why and keeps focus on the confirming button for a retry, unless the member
 * moved to the keeping button or pressed a button exposed beside the dialog, where focus then stays.
 */
export function ConfirmDialog<T>(props: {
  controller: AlertDialogController<T>;
  heading: (record: T) => JSX.Element;
  /** The confirming button's words, which name what it acts on. */
  confirm: (record: T) => string;
  /** The keeping button's words: "Keep it" unless given, or "Keep them" or "Stay". */
  keep?: string;
  /**
   * What the action ends, and whether that is final. `pending` reads true while the confirmed action
   * runs, when nothing in the explanation may lead away from the dialog: its answer would have
   * nowhere to show.
   */
  children: (record: T, pending: () => boolean) => JSX.Element;
  /**
   * Why the action is no longer there to confirm, read live: a read can take it away while the
   * dialog is open. It replaces what the action ends, and the confirming button does nothing.
   */
  withdrawn?: (record: T) => string | undefined;
  /**
   * The page's words for a refusal, an answer with a 4xx status, that the hub words for another case,
   * such as Better Auth's code for the only owner leaving, which it also answers a non-owner removing
   * an owner; otherwise the hub's own words show. Any other failure keeps the dialog's words for it.
   */
  refusal?: (error: unknown) => string | undefined;
  act: (record: T) => Promise<void>;
  /** The page's notice of the outcome, for focus once `act` has resolved. */
  notice: () => HTMLElement | undefined;
}) {
  const { root, finalFocus } = dialogAction(props);
  return (
    <AlertDialog controller={props.controller} pendingAnnouncement="Working…" {...root}>
      <AlertDialogContent<T> finalFocus={finalFocus}>
        {(state) => (
          <Show when={state.payload} keyed>
            {(record) => (
              <>
                <AlertDialogTitle class="dialog-h">{props.heading(record)}</AlertDialogTitle>
                <AlertDialogClose
                  value="confirm"
                  action={async () => {
                    // `act` starts a mutation, which would hold the part's pending state.
                    await untilFlushed();
                    await props.act(record);
                  }}
                  render={(button, close) => {
                    const failure = createMemo(() => {
                      const error = close.error;
                      if (error === undefined) return undefined;
                      const words = isWriteRefusal(error) ? props.refusal?.(error) : undefined;
                      return words ?? hubWriteFailureMessage(error);
                    });
                    return (
                      <>
                        <div class="dialog-b">
                          <AlertDialogDescription
                            render={(description) => (
                              // The explanation is rendered text a read changes, so its own element is
                              // the live region; UI SDK's `announce` is for an action's result that has
                              // no element of its own. Off while the action runs: its own answer
                              // changes the record as the dialog closes.
                              <div {...description} aria-live={close.pending ? "off" : "polite"} />
                            )}
                          >
                            <Show
                              when={withdrawalMessage(props.withdrawn?.(record), failure())}
                              keyed
                              fallback={props.children(record, () => close.pending)}
                            >
                              {(reason) => <p>{reason}</p>}
                            </Show>
                          </AlertDialogDescription>
                          <Show when={close.pending}>
                            <p class="note">Working…</p>
                          </Show>
                          <Show when={failure()} keyed>
                            {(message) => <Notice role="alert">{message}</Notice>}
                          </Show>
                        </div>
                        <div class="dialog-f">
                          <AlertDialogClose>{props.keep ?? "Keep it"}</AlertDialogClose>
                          {/* Disabled, the confirming button keeps the focus a read withdrawing the
                            action finds on it, and refuses presses. */}
                          <Button
                            {...button}
                            class="danger is-fill"
                            disabled={!!props.withdrawn?.(record)}
                            focusableWhenDisabled
                          >
                            {props.confirm(record)}
                          </Button>
                        </div>
                      </>
                    );
                  }}
                />
              </>
            )}
          </Show>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
