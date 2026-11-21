import type { JSX } from "@solidjs/web";
import { useBlocker, useRouter } from "@tanstack/solid-router";
import { problemOf } from "contract";
import { For, Show, createOptimistic, createSignal, createUniqueId, onSettled } from "solid-js";
// Not crypto.randomUUID, which is undefined outside a secure context: the dashboard may be served
// over plain HTTP on a private network (docs/deploy.md, "Runners on other machines",
// "A private network").
import { v4 as uuid } from "uuid";

import { plural } from "../format.ts";
import { isLeavingDocument } from "../member-document.ts";

/**
 * What the hub may hold from earlier sends of the page: a record under the ID the field holds, which
 * sending again would return or refuse, and records under other IDs, which sending leaves as they
 * are.
 */
export interface Earlier {
  readonly repeats?: string;
  readonly others: readonly string[];
}

/** Whether `form` holds a value other than the one it started with. */
function formChanged(form: HTMLFormElement | undefined) {
  return Array.from(form?.elements ?? []).some((control) =>
    control instanceof HTMLInputElement && control.type === "checkbox"
      ? control.checked !== control.defaultChecked
      : (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) &&
        (control.value !== control.defaultValue || control.validity.badInput),
  );
}

/**
 * What a page that submits a draft keeps about its sends: the IDs whose outcome is unknown, whether
 * a create is on its way, and whether the member may leave. The draft is `form`'s, whose field `id`
 * names the record, and leaving loses it when a value changed or `held` says the page holds more.
 * `stop` stops a send still preparing its create, which a confirmed Leave calls at once: the router
 * may keep the page while the next one loads, and the dialog has said nothing was submitted.
 */
export function createDraftSubmission(
  form: () => HTMLFormElement | undefined,
  held: () => boolean = () => false,
  stop: () => void = () => undefined,
) {
  const router = useRouter();
  // The IDs of creates that got no answer saying what the hub did, or whose success came after the
  // member chose to leave: the hub may hold a record under each. Kept until a send under that ID
  // succeeds or the page goes, whatever is edited meanwhile, since a refusal of a later send says
  // nothing of an earlier one. A second answer can be lost under another ID, so there may be several.
  const [possiblyMade, setPossiblyMade] = createSignal<ReadonlySet<string>>(new Set());
  // What the field `id` holds, which decides whether the next send repeats one of them.
  const [idInField, setIdInField] = createSignal("");
  // Optimistic, as the form's pending state is: a send is one action, whose other writes show once
  // it settles. A page calls `creating` where its action runs, before its first wait or after a
  // `yield`, so the stage shows while the create is pending.
  const [stage, setStage] = createOptimistic<"creating" | undefined>(undefined);
  let submitted = false;
  // The member confirmed leaving while this request was pending: its answer must not take them
  // back. A new send clears it, so it covers only the request pending at Leave.
  let leaveConfirmed = false;
  const holdsDraft = () => held() || formChanged(form());
  // With nothing left to lose, leaving still asks while the hub may hold a record from the page.
  const dirty = () => holdsDraft() || possiblyMade().size > 0;
  const blocker = useBlocker({
    // A change of fragment alone, such as the skip link's, does not leave the page.
    shouldBlockFn: ({ current, next }) =>
      current.pathname !== next.pathname && !submitted && dirty(),
    // A document replaced after a sign-out or a change of member must go (ADR 0046).
    enableBeforeUnload: () => !isLeavingDocument() && !submitted && dirty(),
    withResolver: true,
  });
  /**
   * The hub may hold a record under `id`. A made ID is written into the empty field, so the page
   * holds the ID that may be taken: sending again repeats it, and another record takes a deliberate
   * change of it.
   */
  function markPossiblyMade(id: string) {
    setPossiblyMade((previous) => new Set(previous).add(id));
    const field = form()?.elements.namedItem("id");
    if (field instanceof HTMLInputElement && field.value === "") {
      field.value = id;
      setIdInField(id);
    }
  }
  return {
    blocker,
    /** The page holds a draft that leaving loses. */
    holdsDraft,
    /** A create is on its way, or one may have made a record: leaving says the hub may have it. */
    mayHaveRecord: () => stage() === "creating" || possiblyMade().size > 0,
    /** What the hub may hold from an earlier send, if anything. */
    earlier: (): Earlier | undefined => {
      const ids = possiblyMade();
      if (!ids.size) return undefined;
      const typed = idInField();
      const others = [...ids].filter((id) => id !== typed);
      return ids.has(typed) ? { repeats: typed, others } : { others };
    },
    /** The field `id` now holds `value`. */
    idEdited(value: string) {
      setIdInField(value);
    },
    /** The ID to send: the one in the field, or a new one, which the hub's answer will name. */
    takeId(typed: string) {
      return typed || uuid();
    },
    /** A send begins. */
    sending() {
      leaveConfirmed = false;
    },
    /** The create is sent, which cannot be recalled. */
    creating() {
      setStage("creating");
    },
    /**
     * Marks that the hub made or returned the record under `id`, so leaving no longer asks. True
     * when the page is to follow it; a member who left meanwhile finds the form, if they come back,
     * as after a lost answer, `id` written into its field if that is empty, so sending it unchanged
     * opens the record.
     */
    markSucceeded(id: string) {
      if (form()?.isConnected && !leaveConfirmed) {
        submitted = true;
        // A navigation held by an open leave dialog gives way, so the member lands on the record.
        blocker().reset?.();
        return true;
      }
      if (leaveConfirmed) markPossiblyMade(id);
      return false;
    },
    /**
     * Marks that the send under `id` failed with `error`. When that leaves its outcome unknown, `id`
     * is written into the field `id` if that is empty.
     */
    markFailed(error: unknown, id: string) {
      const status = problemOf(error)?.status;
      // A refusal commits nothing. A failure of the hub or the connection may follow a commit.
      if (!(status !== undefined && status >= 400 && status < 500)) markPossiblyMade(id);
      if (status === 403)
        void router.invalidate({ filter: (match) => match.routeId === "/_signed-in" });
    },
    /** The member chose to leave from the dialog. */
    leave() {
      leaveConfirmed = true;
      stop();
      blocker().proceed?.();
    },
  };
}

/**
 * What the alert says while the hub may hold records from earlier sends: while the field holds one's
 * ID, the page's own words, `repeat`, around a link to it, as a repeat does different things to a
 * job and to a Batch; then the records under other IDs, which sending leaves as they are. `link`
 * leads to what the hub holds under an ID, in a new tab and not preloaded, as the page reads
 * nothing of it by itself.
 */
export function EarlierWords(props: {
  /** Nothing while there is nothing earlier, so a page may read it straight from its source. */
  earlier: Earlier | undefined;
  /** "job" or "Batch". */
  record: string;
  /** "jobs" or "Batches". */
  records: string;
  /** "Custom ID" or "Batch ID". */
  idName: string;
  link: (id: string) => JSX.Element;
  repeat: (link: JSX.Element) => JSX.Element;
}) {
  const others = () => props.earlier?.others ?? [];
  const repeats = () => props.earlier?.repeats;
  return (
    <>
      {/* Keyed: the link follows the ID the field holds. */}
      <Show when={repeats()} keyed>
        {(id) => props.repeat(<>{props.link(id)} (opens in a new tab)</>)}
      </Show>
      <Show when={others().length}>
        {repeats() ? "\n" : ""}
        The hub may {repeats() ? "also" : "already"} have{" "}
        {plural(
          others().length,
          `a ${props.record} from an earlier submission`,
          `${props.records} from earlier submissions`,
        )}
        :{" "}
        <For each={others()}>
          {(id, index) => (
            <>
              {index() > 0 ? ", " : ""}
              {props.link(id)}
            </>
          )}
        </For>{" "}
        {plural(others().length, "(opens in a new tab)", "(each opens in a new tab)")}.
        <Show when={!repeats()}>
          {" "}
          {plural(
            others().length,
            `Submitting now goes under another ${props.idName} and leaves that one as it is.`,
            `Submitting now goes under another ${props.idName} and leaves those as they are.`,
          )}
        </Show>
      </Show>
    </>
  );
}

/**
 * The question before leaving a draft not yet sent, while the router holds the navigation. While a
 * send may have made the record, it says so and where to look before submitting it again.
 */
export function LeaveDialog(props: {
  submission: ReturnType<typeof createDraftSubmission>;
  /** "job" or "Batch". */
  record: string;
  /** The list to look in, such as "Jobs". */
  list: string;
  /** What leaving loses, such as "what you typed". */
  loses: string;
}) {
  const headingId = createUniqueId();
  return (
    <dialog
      aria-labelledby={headingId}
      ref={(element) => {
        onSettled(() => element.showModal());
      }}
      onClose={() => props.submission.blocker().reset?.()}
    >
      <form method="dialog">
        <h2 class="dialog-h" id={headingId}>
          {props.submission.mayHaveRecord() ? "Leave this page?" : "Leave without submitting?"}
        </h2>
        <div class="dialog-b">
          <p>
            {props.submission.mayHaveRecord()
              ? `The hub may already have a ${props.record} from this page: look for it in ${props.list} before submitting it again.`
              : `The ${props.record} has not been submitted.`}
            {props.submission.holdsDraft() ? ` Leaving this page loses ${props.loses}.` : ""}
          </p>
        </div>
        <div class="dialog-f">
          <button value="keep" autofocus>
            Stay
          </button>
          <button type="button" class="danger is-fill" onClick={() => props.submission.leave()}>
            Leave the page
          </button>
        </div>
      </form>
    </dialog>
  );
}
