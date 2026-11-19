import { authClient } from "./auth-client.ts";

let documentMember: string | undefined;
let signOutHref: string | undefined;
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

export function reloadIfMemberChanged(memberId: string | null) {
  if (documentMember !== undefined && documentMember !== memberId) return leaveDocument();
  return leaving;
}

export function watchDocumentMember(memberId: string) {
  if (documentMember !== undefined) return;
  documentMember = memberId;
  // Only the signed-in shell establishes whose page has been shown. Keep the subscription for
  // the document's life, including a subsequent visit to a page outside the shell.
  authClient.useSession.subscribe((session) => {
    if (session.isPending || session.isRefetching) return;
    // A 401 clears Better Auth's session. Other errors say nothing about who is signed in.
    if (session.error && session.error.status !== 401) return;
    void reloadIfMemberChanged(session.data?.user.id ?? null);
  });
}

export async function signOutTo(href: string) {
  // A session read can see the sign-out before the button gets its answer. Either one must
  // take the member to the plain sign-in page.
  signOutHref = href;
  try {
    const answer = await authClient.signOut();
    if (answer.error) return answer;
    return await leaveDocument();
  } finally {
    signOutHref = undefined;
  }
}
