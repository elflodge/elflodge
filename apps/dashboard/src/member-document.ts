import { authClient, isSignedOutError } from "./auth-client.ts";

/** The member whose shell this document has shown. Undefined until the first shell is shown. */
let documentMember: string | undefined;
/** The destination of a pending sign-out, also used if a session read observes sign-out first. */
let signOutHref: string | undefined;
/** Holds callers in this document until the browser replaces it. */
let leaving: Promise<never> | undefined;

function leaveDocument() {
  // A second navigation can cancel the first. Keep any waiting route from showing another
  // member while the browser loads the new document.
  if (!leaving) {
    leaving = new Promise<never>(() => {});
    if (signOutHref !== undefined) window.location.replace(signOutHref);
    else window.location.reload();
  }
  return leaving;
}

/** A null member ID means no one is signed in. A new document has no member to compare yet. */
export function reloadAndWaitIfMemberChanged(memberId: string | null) {
  // Replacing the document discards the previous member's mounted views and pending callbacks together.
  if (documentMember !== undefined && documentMember !== memberId) return leaveDocument();
  return leaving;
}

/** Watch for a change of member after the signed-in shell first appears. */
export function watchDocumentMember(memberId: string) {
  if (documentMember !== undefined) return;
  documentMember = memberId;
  // Only the signed-in shell establishes whose page has been shown. Keep the subscription for
  // the document's life, including a subsequent visit to a page outside the shell.
  authClient.useSession.subscribe((session) => {
    if (session.isPending || session.isRefetching) return;
    // With throw enabled Better Auth keeps the last data on failure. A 401 ends the session.
    if (session.error) {
      if (isSignedOutError(session.error)) void reloadAndWaitIfMemberChanged(null);
    } else {
      void reloadAndWaitIfMemberChanged(session.data?.user.id ?? null);
    }
  });
}

/** End the session and load a fresh document, at `href` or at the current address. */
export async function signOutTo(href?: string) {
  // A session read can see the sign-out before the button gets its answer. Either one must
  // load the requested document. Reloading the current address also preserves its fragment.
  signOutHref = href;
  try {
    await authClient.signOut();
    return await leaveDocument();
  } finally {
    signOutHref = undefined;
  }
}
