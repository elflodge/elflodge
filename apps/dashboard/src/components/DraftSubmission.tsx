import { useBlocker, useRouter } from "@tanstack/solid-router";
import { problemOf } from "contract";
import { createSignal, createUniqueId, onSettled } from "solid-js";
// Not crypto.randomUUID, which is undefined outside a secure context: the dashboard may be served
// over plain HTTP on a private network (docs/deploy.md, "Runners on other machines",
// "A private network").
import { v4 as uuid } from "uuid";

import { isLeavingDocument } from "../member-document.ts";

/** Which ID a creation was sent under: one the page made, or one the member typed. */
export type SentUnder = "made ID" | "typed ID";

/**
 * What a page that submits a draft keeps about its sends: the ID it made, whether a send's outcome
 * is unknown, and whether the member may leave. `dirty` says whether leaving would lose anything.
 */
export function createDraftSubmission(dirty: () => boolean) {
  const router = useRouter();
  // Kept so that a retry after a lost answer sends the same ID, and the hub answers with what it
  // made instead of making a second one.
  let madeId: string | undefined;
  // A request was sent, and got no answer that says what the hub did, or its success came after
  // the member chose to leave. Holds which kind of ID it was sent under. A later refusal of the
  // same draft says nothing of that request, so only a change that gives the next send another ID
  // or a success the page follows settles it.
  const [unknownOutcome, setUnknownOutcome] = createSignal<SentUnder>();
  let submitted = false;
  // The member confirmed leaving while this request was pending: its answer must not take them
  // back. A new send clears it, so it covers only the request pending at Leave.
  let leaveConfirmed = false;
  const blocker = useBlocker({
    // A change of fragment alone, such as the skip link's, does not leave the page.
    shouldBlockFn: ({ current, next }) =>
      current.pathname !== next.pathname && !submitted && dirty(),
    // A document replaced after a sign-out or a change of member must go (ADR 0046).
    enableBeforeUnload: () => !isLeavingDocument() && !submitted && dirty(),
    withResolver: true,
  });
  return {
    blocker,
    unknownOutcome,
    /**
     * Takes the ID to send: the one typed, or the one made and kept since the last change, making
     * and keeping one when none is.
     */
    takeId(typed: string): { id: string; sentUnder: SentUnder } {
      if (typed) return { id: typed, sentUnder: "typed ID" };
      madeId ??= uuid();
      return { id: madeId, sentUnder: "made ID" };
    },
    /** The made ID the next send would use, if one is kept. */
    madeId: () => madeId,
    /**
     * Something on the page changed. A made ID gets a new one, so the next send can make a second
     * record. Under a typed ID only an edit of that ID does: the hub refuses other content under it.
     */
    changed(ofId: boolean) {
      madeId = undefined;
      setUnknownOutcome((sentUnder) => (sentUnder === "typed ID" && !ofId ? sentUnder : undefined));
    },
    /** A send begins. */
    sending() {
      leaveConfirmed = false;
    },
    /**
     * Marks that the hub made or returned the record, so leaving no longer asks. True when the page
     * is to follow it; a member who left
     * meanwhile finds the form, if they come back, as after a lost answer, so sending it unchanged
     * opens the record.
     */
    markSucceeded(form: HTMLFormElement, sentUnder: SentUnder) {
      if (form.isConnected && !leaveConfirmed) {
        submitted = true;
        // A navigation held by an open leave dialog gives way, so the member lands on the record.
        blocker().reset?.();
        return true;
      }
      if (leaveConfirmed) setUnknownOutcome(sentUnder);
      return false;
    },
    /** Marks that the send failed with `error`, which may leave its outcome unknown. */
    markFailed(error: unknown, sentUnder: SentUnder) {
      const status = problemOf(error)?.status;
      // A refusal commits nothing. A failure of the hub or the connection may follow a commit.
      if (!(status !== undefined && status >= 400 && status < 500)) setUnknownOutcome(sentUnder);
      if (status === 403)
        void router.invalidate({ filter: (match) => match.routeId === "/_signed-in" });
    },
    /** The member chose to leave from the dialog. */
    leave() {
      leaveConfirmed = true;
      blocker().proceed?.();
    },
  };
}

/** What the alert says after a send under a made ID got no answer: `record` is "job" or "Batch". */
export function madeIdUnknownWords(record: string) {
  return `The hub may already have this ${record}. Submit again without changing anything to find out: the same request returns the ${record} if it was made.`;
}

/**
 * The question before leaving a draft not yet sent, while the router holds the navigation. While a
 * send may have made the record, it says so and where to look before submitting it again.
 */
export function LeaveDialog(props: {
  submission: ReturnType<typeof createDraftSubmission>;
  /** A send is pending that may make the record, or one got no answer. */
  mayHaveRecord: boolean;
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
          {props.mayHaveRecord ? "Leave this page?" : "Leave without submitting?"}
        </h2>
        <div class="dialog-b">
          <p>
            {props.mayHaveRecord
              ? `The hub may already have this ${props.record}: look for it in ${props.list} before submitting it again.`
              : `The ${props.record} has not been submitted.`}{" "}
            Leaving this page loses {props.loses}.
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
