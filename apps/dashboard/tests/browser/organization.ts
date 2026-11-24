import type { Member } from "../../src/organization.ts";
import type { Hub, Session } from "../hub.ts";
import { memberOf, roster } from "../records.ts";

// The Organization page's arrangements, for its tests, which are in a file per member: the app
// reloads a document once another member than the first it showed is signed in
// (member-document.ts), and Vitest gives each file a document of its own.

/**
 * Arranges what the page reads for `session`'s member, listed among `others`: the members, and for
 * an owner or admin, no invitations and no keys unless a test arranges them.
 */
export function arrangeOrganization(hub: Hub, session: NonNullable<Session>, ...others: Member[]) {
  hub.session.answers(session);
  hub.auth.organization.listMembers.answers(roster(memberOf(session), ...others));
  hub.invitations.list.answers([]);
  hub.apiKeys.list.answers([]);
}
