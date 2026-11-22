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
import { Show } from "solid-js";

import { hubWriteFailureMessage } from "../api-client.ts";
import { untilFlushed } from "../query.ts";
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
 * The page reads each query it shows that reads again under the same key, by a poll or an
 * invalidation, through `latest`, as `createMemo(() => latest(() => deep(query.data)))`: a pass that
 * reads a query still being read again can hold the dialog's writes until that read lands.
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
  /**
   * Why the action is no longer there to confirm, read live: a read can take it away while the
   * dialog is open. It replaces what the action ends, and the confirming button does nothing.
   */
  withdrawn?: (record: T) => string | undefined;
  act: (record: T) => Promise<void>;
  /** The page's notice of the outcome, for focus once `act` has resolved. */
  notice: () => HTMLElement | undefined;
}) {
  // Only an outcome the page shows takes focus: a keep or Escape returns it to the trigger, even
  // with an older notice on the page. A resolved action closes with the reason "action".
  let acted = false;
  return (
    <AlertDialog
      controller={props.controller}
      // Beside the page rather than in it: UI SDK makes inert what is beside the dialog when it opens,
      // so the page's root holds everything else, a list or a notice rendered later included.
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
                    // `act` starts a mutation, which would hold the part's pending state.
                    await untilFlushed();
                    await props.act(record);
                  }}
                  render={(button, close) => (
                    <>
                      <div class="dialog-b">
                        <AlertDialogDescription
                          render={(description) => (
                            // What a read changes while the dialog is open is announced, but not
                            // while the action runs: its own answer changes the record as it closes.
                            <div {...description} aria-live={close.pending ? "off" : "polite"} />
                          )}
                        >
                          <Show
                            when={props.withdrawn?.(record)}
                            keyed
                            fallback={props.children(record)}
                          >
                            {(reason) => <p>{reason}</p>}
                          </Show>
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
