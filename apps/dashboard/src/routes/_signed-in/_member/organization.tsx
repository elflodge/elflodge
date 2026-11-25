import type { JSX } from "@solidjs/web";
import { focusManager, noop, useMutation, useQuery, useQueryClient } from "@tanstack/solid-query";
import { Link, createFileRoute, useRouter } from "@tanstack/solid-router";
import { AlertDialogTrigger, createAlertDialogController } from "@ui-sdk/solid/alert-dialog";
import { DialogTrigger, createDialogController } from "@ui-sdk/solid/dialog";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  deep,
  flush,
  latest,
  onFlush,
} from "solid-js";

import {
  HUB_DEADLINE_MS,
  hubFailureDetail,
  isWriteRefusal,
  readFromHub,
} from "../../../api-client.ts";
import { authClient, hasAuthCode, isAuthAccessError } from "../../../auth-client.ts";
import { ConfirmDialog } from "../../../components/ConfirmDialog.tsx";
import { CopyButton } from "../../../components/CopyButton.tsx";
import { FailedReadNotice, ReadErrorPage } from "../../../components/FailedReadNotice.tsx";
import { Instant } from "../../../components/Instant.tsx";
import { Notice } from "../../../components/Notice.tsx";
import {
  ChangeRole,
  InviteMember,
  InvitationAddressNote,
  RenameOrganization,
} from "../../../components/OrganizationForms.tsx";
import { plural, timeZoneNote } from "../../../format.ts";
import {
  asRole,
  invitationLink,
  invitationsOptions,
  membersOptions,
  readMembers,
  roleLabel,
  rolesOf,
  type Member,
  type MemberRole,
} from "../../../organization.ts";
import { memberPageHead } from "../../../page-title.ts";
import { PAGE_LOAD, orpc, writeAbsence } from "../../../query.ts";

export const Route = createFileRoute("/_signed-in/_member/organization")({
  head: ({ match }) => memberPageHead(match.context, "Organization"),
  loader: async ({ context: { member, queryClient, managesKeys } }) => {
    if (!member) return;
    await Promise.all([
      readFromHub("The members", () =>
        queryClient.query({ ...membersOptions(member.organization.id), ...PAGE_LOAD }),
      ),
      managesKeys &&
        readFromHub("The invitations", () =>
          queryClient.query({ ...invitationsOptions(member.role), ...PAGE_LOAD }),
        ),
      // Wait for counts, but let the page show a failed keys read alongside the roster.
      managesKeys && queryClient.query(orpc.apiKeys.list.queryOptions(PAGE_LOAD)).catch(noop),
    ]);
  },
  errorComponent: (props) => <ReadErrorPage {...props} heading="Organization" />,
  component: Organization,
});

/** A member to remove, or the member leaving, and the Organization, as shown at the press. */
type Membership = { member: Member; organization: string | undefined };
/** An invitation to revoke, as shown when Revoke was pressed. */
type Revocation = { id: string; email: string; role: string };

const MANAGERS_ONLY = "Only owners and admins invite members, change roles and remove members.";
const OWNERS_REMOVE_OWNERS = "Only an owner can remove an owner.";
const OWNERS_CHANGE_OWNERS = "Only an owner can change the role of an owner.";
const NOW_ONLY_OWNER = "You are now the only owner, so you cannot leave or change your own role.";
// Better Auth's client has no deadline of its own. A write a confirmation or a form dialog waits on,
// and a read it waits on, take better-fetch's, which ends a call whose answer's headers have not
// arrived by then.
const CONFIRMED = { timeout: HUB_DEADLINE_MS };

const rank = { owner: 0, admin: 1, member: 2 };
function roleRank(role: string) {
  return rank[rolesOf(role)[0] ?? "member"];
}

function soleOwner(list: Member[], userId: string) {
  const owners = list.filter((member) => rolesOf(member.role).includes("owner"));
  return owners.length === 1 && owners[0]?.userId === userId;
}

function manager(member: Member) {
  return rolesOf(member.role).some((role) => role !== "member");
}

function canChangeRole(list: Member[], reader: Member, target: Member) {
  const grant = rolesOf(reader.role);
  if (reader.id === target.id && soleOwner(list, reader.userId)) return false;
  return (
    grant.includes("owner") || (grant.includes("admin") && !rolesOf(target.role).includes("owner"))
  );
}

function TableHead(props: { columns: string[] }) {
  return (
    <thead role="rowgroup">
      <tr role="row">
        <For each={props.columns}>
          {(column) => (
            <th scope="col" role="columnheader">
              {column}
            </th>
          )}
        </For>
        <th scope="col" role="columnheader">
          <span class="vh">Actions</span>
        </th>
      </tr>
    </thead>
  );
}

function Organization() {
  const context = Route.useRouteContext();
  return (
    <Show when={context().member?.organization.id} keyed>
      {(organizationId) => <OrganizationPage organizationId={organizationId} />}
    </Show>
  );
}

/**
 * Better Auth refuses a non-owner removing an owner with its code for the only owner leaving, whose
 * words are about leaving: the page's own words say why.
 */
function removalRefusal(error: unknown) {
  return hasAuthCode(error, "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER")
    ? OWNERS_REMOVE_OWNERS
    : undefined;
}

/**
 * Better Auth refuses the only owner changing their own role with its code for an Organization left
 * without an owner, which it answers no other change of role.
 */
function roleChangeRefusal(error: unknown) {
  return hasAuthCode(error, "YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER")
    ? { fields: new Map<string, string>(), alert: NOW_ONLY_OWNER }
    : undefined;
}

function OrganizationPage(props: { organizationId: string }) {
  const context = Route.useRouteContext();
  const router = useRouter();
  const client = useQueryClient();
  // The route context gives a new member on each navigation, so the Show is keyed on the
  // Organization's ID alone and its name and the member's role are read from the context. They are
  // missing only while the Show takes the page away, when the invitations are not read.
  const org = () => context().member?.organization;
  const orgId = () => props.organizationId;
  const role = () => context().member?.role;
  const owner = () => {
    const current = role();
    return current !== undefined && rolesOf(current).includes("owner");
  };
  const manages = () => context().managesKeys;
  const members = useQuery(() => membersOptions(orgId()));
  const invitations = useQuery(() => ({
    ...invitationsOptions(role()),
    enabled: manages() && role() !== undefined,
  }));
  const keys = useQuery(() =>
    orpc.apiKeys.list.queryOptions({ enabled: manages(), retryOnMount: false }),
  );
  // Each list is read through `latest`: while a query that has data reads again under the same key,
  // its `data` is pending, and a pass that reads it holds every write staged with it, a confirmation's
  // included, until the read lands. A read of `data` with none yet waits for it, so the invitations
  // are read only for a member who manages them, and key counts only from a read that succeeded.
  const roster = createMemo(() => latest(() => deep(members.data)));
  const invitationList = createMemo(() => (manages() ? latest(() => deep(invitations.data)) : []));
  const keyList = createMemo(() => (keys.isSuccess ? latest(() => deep(keys.data)) : undefined));
  const [now, setNow] = createSignal(Date.now());
  const liveInvitations = createMemo(() =>
    invitationList().filter((invite) => invite.expiresAt.getTime() > now()),
  );
  const activeKeys = createMemo(() =>
    (keyList() ?? []).filter((key) => key.expiresAt === null || key.expiresAt.getTime() > now()),
  );
  const checkExpiry = () => setNow(Date.now());
  createEffect(
    () => {
      const expires = Math.min(
        ...liveInvitations().map((invite) => invite.expiresAt.getTime()),
        ...activeKeys().map((key) => key.expiresAt?.getTime() ?? Infinity),
      );
      // A key can outlive the browser's maximum timeout of 2^31 - 1 milliseconds.
      return Number.isFinite(expires) ? Math.min(expires, now() + 2 ** 31 - 1) : expires;
    },
    (expires) => {
      if (!Number.isFinite(expires)) return undefined;
      // A suspended tab may miss its timer. Check its clock again when it becomes visible.
      const timer = setTimeout(checkExpiry, Math.max(0, expires - Date.now()));
      const unsubscribe = focusManager.subscribe(checkExpiry);
      return () => {
        clearTimeout(timer);
        unsubscribe();
      };
    },
  );
  // What was done, the outcome of a confirmation or a form dialog, which then focuses it.
  const [notice, setNotice] = createSignal<{ message: JSX.Element }>();
  let noticeElement: HTMLElement | undefined;
  const status = (message: JSX.Element) => setNotice({ message });
  // Set once the member has left: the page is stale until the session read replaces it, so it shows
  // only what happened.
  const [left, setLeft] = createSignal(false);
  const ordered = () =>
    roster().members.toSorted(
      (a, b) => roleRank(a.role) - roleRank(b.role) || a.user.name.localeCompare(b.user.name),
    );
  const onlyOwner = () => owner() && soleOwner(roster().members, context().user.id);
  const refreshMembers = () =>
    client.invalidateQueries({ queryKey: membersOptions(orgId()).queryKey, exact: true });
  const refreshInvites = () => client.invalidateQueries({ queryKey: orpc.invitations.list.key() });
  const refreshKeys = () => client.invalidateQueries({ queryKey: orpc.apiKeys.list.key() });
  // Each refresh reads the session anew rather than join a read under way, which may have been
  // answered before the change it is for; invalidated again, the router publishes its latest load,
  // so an answer to an earlier read that arrives last cannot bring back the controls of a role the
  // member no longer has.
  const refreshSession = () => router.invalidate();
  const isOwn = (person: Member) => person.userId === context().user.id;
  const currentMember = (person: Member) =>
    roster().members.find((m) => m.id === person.id) ?? person;
  const canInviteOrRename = createMemo(() => {
    const reader = roster().members.find(isOwn);
    // A missing reader leaves the session read to replace the page, as for Remove.
    return !left() && manages() && (!reader || manager(reader));
  });
  // A background member read may discover a change in another tab. The session is read again
  // whenever the reader's role in the members differs from what they last showed, the reader absent
  // (null) counting as a role of its own, and on the first roster when it differs from the
  // session's; also on each new 401 or 403 from a members read. A role changed and changed back
  // while the first read is under way thus starts a second, whose answer the router publishes.
  // Reads start only when the members' answer changes, so a session that keeps disagreeing, or a
  // read that fails, cannot loop.
  createEffect(
    () => ({
      readerRole: roster().members.find(isOwn)?.role ?? null,
      sessionRole: role(),
      error: members.error,
    }),
    ({ readerRole, sessionRole, error }, before) => {
      if (isAuthAccessError(error) && error !== before?.error) void refreshSession();
      if (readerRole !== (before === undefined ? sessionRole : before.readerRole))
        void refreshSession();
    },
  );

  function refreshAfterMembershipChange() {
    // The reader’s role determines which invitations they can manage. Key creators may have left.
    void refreshInvites();
    void refreshKeys();
    return refreshMembers();
  }

  /**
   * After Better Auth's MEMBER_NOT_FOUND, which also means the reader is no member: one read of the
   * members, while the dialog waits, decides whether `person` is gone, and then writes that alone.
   * Tried once, within the confirmation's deadline, offline too: Query's `fetchQuery` would join a
   * read in flight, with its retries and its pause while offline. A reader who is no member gets a
   * 403 from it. Any failed check leaves the reader’s membership unresolved and refreshes the session.
   */
  async function memberGone(organizationId: string, person: Member) {
    const current = await readMembers(organizationId, CONFIRMED).catch(() => {
      void refreshSession();
      return undefined;
    });
    if (!current) return undefined;
    if (current.members.some((m) => m.id === person.id)) return false;
    await writeAbsence(client, membersOptions(organizationId).queryKey, (cached) => {
      const remaining = cached.members.filter((m) => m.id !== person.id);
      return remaining.length === cached.members.length
        ? cached
        : { members: remaining, total: cached.total - 1 };
    });
    return true;
  }

  /** A refused membership change: the lists are read again, and a fresh roster can withdraw it. */
  function refusedMembership(error: unknown) {
    if (isAuthAccessError(error)) void refreshSession();
    void refreshAfterMembershipChange();
  }

  const leaving = useMutation(() => ({
    mutationFn: (input: { organizationId: string }) =>
      authClient.organization.leave({ ...input, fetchOptions: CONFIRMED }),
  }));
  const removing = useMutation(() => ({
    mutationFn: (input: { organizationId: string; memberIdOrEmail: string }) =>
      authClient.organization.removeMember({ ...input, fetchOptions: CONFIRMED }),
  }));
  const changingRole = useMutation(() => ({
    mutationFn: (input: { organizationId: string; memberId: string; role: MemberRole }) =>
      authClient.organization.updateMemberRole({ ...input, fetchOptions: CONFIRMED }),
  }));
  const revokingInvitation = useMutation(() => ({
    mutationFn: (input: { invitationId: string }) =>
      authClient.organization.cancelInvitation({ ...input, fetchOptions: CONFIRMED }),
  }));
  const renaming = useMutation(() => ({
    mutationFn: (input: { organizationId: string; data: { name: string } }) =>
      authClient.organization.update({ ...input, fetchOptions: CONFIRMED }),
  }));

  const confirmRemove = createAlertDialogController<Membership>();
  const confirmLeave = createAlertDialogController<Membership>();
  const confirmRevoke = createAlertDialogController<Revocation>();
  const inviteDialog = createDialogController();
  const renameDialog = createDialogController();
  const changeRoleDialog = createDialogController<Member>();

  async function remove({ member: person }: Membership) {
    const organizationId = orgId();
    const name = person.user.name;
    // On its own: written beside the request, it would be held until it settles.
    onFlush(() => setNotice(undefined));
    try {
      await removing.mutate({ organizationId, memberIdOrEmail: person.id });
    } catch (error) {
      if (
        isWriteRefusal(error) &&
        hasAuthCode(error, "MEMBER_NOT_FOUND") &&
        (await memberGone(organizationId, person))
      ) {
        status(`${name} is already gone.`);
        // On the page before the dialog closes and focus moves to it.
        flush();
        void refreshInvites();
        void refreshKeys();
        return;
      }
      // A reader who is no longer a member: the members read above has started the session read,
      // which replaces the page.
      refusedMembership(error);
      throw error;
    }
    status(`${name} is removed.`);
    // Render the outcome before starting reads that may need to retry. They start before UI SDK
    // closes the dialog, which is no matter: nothing the dialog, the notice or a row reads waits for
    // them.
    flush();
    void refreshAfterMembershipChange();
  }

  async function leave({ organization }: Membership) {
    const organizationId = orgId();
    // On its own: written beside the request, it would be held until it settles.
    onFlush(() => setNotice(undefined));
    try {
      await leaving.mutate({ organizationId });
    } catch (error) {
      refusedMembership(error);
      throw error;
    }
    setLeft(true);
    status(`You left ${organization}.`);
    flush();
    // The session read replaces the page, and the Organization access heading takes focus from the
    // notice. Nothing waits on it. It reruns the shell's `beforeLoad`, whose `getSession()` has no
    // deadline, as Better Auth's client sets none.
    void refreshSession();
  }

  async function changeRole(person: Member, next: MemberRole) {
    const own = isOwn(person);
    const organizationId = orgId();
    // On its own: written beside the request, it would be held until it settles.
    onFlush(() => setNotice(undefined));
    try {
      await changingRole.mutate({ organizationId, memberId: person.id, role: next });
    } catch (error) {
      if (
        isWriteRefusal(error) &&
        hasAuthCode(error, "MEMBER_NOT_FOUND") &&
        (await memberGone(organizationId, person))
      ) {
        status(`${person.user.name} is already gone.`);
        // On the page before the dialog closes and focus moves to it.
        flush();
        void refreshInvites();
        void refreshKeys();
        return;
      }
      // A fresh roster can withdraw the change, which the dialog then says.
      refusedMembership(error);
      throw error;
    }
    status(
      own
        ? `You are now ${asRole(next)}.`
        : `${currentMember(person).user.name} is now ${asRole(next)}.`,
    );
    flush();
    void refreshAfterMembershipChange();
    // One's own role decides what the page offers, from the session: until it is read again, the
    // page still offers the old role's controls.
    if (own) void refreshSession();
  }

  async function rename(name: string) {
    try {
      const renamed = await renaming.mutate({ organizationId: orgId(), data: { name } });
      status(`Renamed to ${renamed.name}.`);
      flush();
    } finally {
      // The bar and this page name the Organization from the session.
      void refreshSession();
    }
  }

  async function revoke(invite: Revocation) {
    const label = (
      <>
        The invitation for <span class="mono">{invite.email}</span>
      </>
    );
    const queryKey = invitationsOptions(role()).queryKey;
    // On its own: written beside the request, it would be held until it settles.
    onFlush(() => setNotice(undefined));
    try {
      await revokingInvitation.mutate({ invitationId: invite.id });
    } catch (error) {
      // The invitation was removed or already used. A reader without permission gets another code.
      if (isWriteRefusal(error) && hasAuthCode(error, "INVITATION_NOT_FOUND")) {
        await writeAbsence(client, queryKey, (cached) =>
          cached.filter((item) => item.id !== invite.id),
        );
        status(<>{label} is already gone.</>);
        flush();
        return;
      }
      if (isAuthAccessError(error)) void refreshSession();
      void refreshMembers();
      void refreshInvites();
      throw error;
    }
    status(<>{label} is revoked.</>);
    flush();
    void refreshInvites();
  }

  // Why a confirmation the member opened is no longer there to confirm, by the roster as last read.
  // A reader no longer listed is left to the session read, which replaces the page.
  function removalWithdrawn({ member: person }: Membership) {
    const list = roster().members;
    const reader = list.find(isOwn);
    const target = list.find((m) => m.id === person.id);
    if (!reader) return undefined;
    if (!target) return `${person.user.name} is no longer a member.`;
    if (canChangeRole(list, reader, target)) return undefined;
    return manager(reader) ? OWNERS_REMOVE_OWNERS : MANAGERS_ONLY;
  }

  // Why a role change the member opened no longer applies, by the roster as last read, as for Remove.
  function roleChangeWithdrawn(person: Member) {
    const list = roster().members;
    const reader = list.find(isOwn);
    const target = list.find((m) => m.id === person.id);
    if (!reader) return undefined;
    if (!target) return `${person.user.name} is no longer a member.`;
    if (canChangeRole(list, reader, target)) return undefined;
    if (reader.id === target.id && soleOwner(list, reader.userId)) return NOW_ONLY_OWNER;
    return manager(reader) ? OWNERS_CHANGE_OWNERS : MANAGERS_ONLY;
  }

  function leaveWithdrawn() {
    return soleOwner(roster().members, context().user.id) ? NOW_ONLY_OWNER : undefined;
  }

  // Only a reader who may no longer revoke it: the list leaves out an invitation accepted, revoked
  // elsewhere or expired alike, so its leaving the list does not mean it was revoked, and one that
  // expired while its Revoke was open can still be revoked. The answer to revoking it says which.
  function revocationWithdrawn(invite: Revocation) {
    const reader = roster().members.find(isOwn);
    if (reader && rolesOf(invite.role).includes("owner") && !rolesOf(reader.role).includes("owner"))
      return "Only an owner can revoke an invitation to be an owner.";
    return !manages() || (reader && !manager(reader))
      ? "Only owners and admins can revoke invitations."
      : undefined;
  }

  // `pending`: while Remove runs, its links lead nowhere, so the answer stays where it shows.
  function consequences(
    person: Member,
    next: MemberRole | "remove" | "leave",
    pending?: () => boolean,
  ) {
    if (!manages() || person.role === next) return undefined;
    const own = isOwn(person);
    const sent = liveInvitations().filter((invite) => invite.inviter.id === person.userId).length;
    const keepKeys = ["remove", "leave", "member"].includes(next);
    const count =
      keyList() === undefined
        ? undefined
        : activeKeys().filter((key) => key.creator?.id === person.userId).length;
    const creator = own ? "you created" : `created by ${person.user.name}`;
    return (
      <>
        <Show when={keepKeys && keys.isError}>
          <FailedReadNotice
            what="The API keys"
            detail={hubFailureDetail(keys.error)}
            failedAt={keys.errorUpdatedAt}
          />
        </Show>
        <Show when={keepKeys && (keys.isError || (count ?? 0) > 0)}>
          <p>
            {count === undefined
              ? `API keys ${creator} keep working.`
              : `${count} active API ${plural(count, "key", "keys")} ${creator} ${plural(count, "keeps", "keep")} working.`}
            <Show when={next === "remove"}>
              {" "}
              Review {count === 1 ? "it" : "them"} under{" "}
              <Link to="/api-keys" disabled={pending?.()}>
                API keys
              </Link>
              {count === undefined
                ? " and "
                : `, and the Runners registered with ${count === 1 ? "it" : "them"} under `}
              <Link to="/runners" disabled={pending?.()}>
                Runners
              </Link>
              .
            </Show>
          </p>
        </Show>
        <Show when={next !== "owner" && sent > 0}>
          <p>
            {own ? "Your" : "Their"} {sent} pending{" "}
            {plural(sent, "invitation stays", "invitations stay")} valid. Revoke unwanted
            invitations separately.
          </p>
        </Show>
      </>
    );
  }

  return (
    <>
      <div class="head">
        <h1>Organization</h1>
        <Show when={canInviteOrRename()}>
          <div class="controls">
            <DialogTrigger controller={inviteDialog} class="primary">
              Invite a member
            </DialogTrigger>
          </div>
        </Show>
      </div>
      <Show when={!left()}>
        <div class="org-name">
          <strong>{org()?.name}</strong>
          <Show when={canInviteOrRename()}>
            <DialogTrigger controller={renameDialog}>Rename</DialogTrigger>
          </Show>
        </div>
      </Show>
      {/* The notice and the failed reads' notices, live regions, stay outside the tables: UI SDK leaves
          live regions and their ancestors out of what an open confirmation makes inert, so a row's
          controls beside one, a row a read adds included, would stay pressable behind it. */}
      <Show when={notice()} keyed>
        {({ message }) => (
          <Notice
            role="status"
            focusRef={(element) => {
              noticeElement = element;
            }}
          >
            {message}
          </Notice>
        )}
      </Show>
      <Show when={!left()}>
        <For
          each={[
            { what: "The members", query: members },
            ...(manages()
              ? [
                  { what: "The invitations", query: invitations },
                  { what: "The API keys", query: keys },
                ]
              : []),
          ]}
        >
          {({ what, query }) => (
            <Show when={query.isError}>
              <FailedReadNotice
                what={what}
                detail={hubFailureDetail(query.error)}
                failedAt={query.errorUpdatedAt}
                readAt={query.dataUpdatedAt}
              />
            </Show>
          )}
        </For>
        <section class="record-section">
          <h2>Members</h2>
          <p>
            {roster().total} {plural(roster().total, "member", "members")}
          </p>
          <p class="note">{timeZoneNote()}</p>
          <table class="records is-fit" role="table">
            <caption class="vh">Members</caption>
            <TableHead columns={["Name", "Email", "Role", "Joined"]} />
            <tbody role="rowgroup">
              <For each={ordered()} keyed={(m) => m.id}>
                {(row) => {
                  const own = () => isOwn(row());
                  const canChange = () => {
                    const reader = roster().members.find(isOwn);
                    return (
                      manages() &&
                      reader !== undefined &&
                      canChangeRole(roster().members, reader, row())
                    );
                  };
                  const name = () => row().user.name;

                  return (
                    <tr role="row">
                      <td role="cell" class="is-id">
                        {name()}
                        <Show when={own()}>
                          {" "}
                          <small class="note">you</small>
                        </Show>
                      </td>
                      <td role="cell" data-l="Email" class="mono">
                        {row().user.email}
                      </td>
                      <td role="cell" data-l="Role">
                        {roleLabel(row().role)}
                      </td>
                      <td role="cell" data-l="Joined">
                        <Instant value={row().createdAt} />
                      </td>
                      <td role="cell" class="is-act">
                        <div class="controls">
                          <Show when={canChange()}>
                            <DialogTrigger
                              controller={changeRoleDialog}
                              payload={row()}
                              aria-label={
                                own() ? "Change role for yourself" : `Change role for ${name()}`
                              }
                            >
                              Change role
                            </DialogTrigger>
                          </Show>
                          <Show when={!own() && canChange()}>
                            <AlertDialogTrigger
                              controller={confirmRemove}
                              payload={{ member: row(), organization: org()?.name }}
                              class="danger"
                              aria-label={`Remove ${name()}`}
                            >
                              Remove
                            </AlertDialogTrigger>
                          </Show>
                          <Show when={own() && !onlyOwner()}>
                            <AlertDialogTrigger
                              controller={confirmLeave}
                              payload={{ member: row(), organization: org()?.name }}
                              class="danger"
                              aria-label={`Leave ${org()?.name}`}
                            >
                              Leave
                            </AlertDialogTrigger>
                          </Show>
                        </div>
                      </td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>
          <Show when={onlyOwner()}>
            <p class="note">
              You are the only owner, so you cannot leave or change your own role. To hand the
              Organization over, make another member an owner first; then you can do either.
            </p>
          </Show>
          <Show when={!owner()}>
            <p class="note">
              {manages()
                ? "Only an owner can change or remove an owner, or invite one."
                : MANAGERS_ONLY}
            </p>
          </Show>
        </section>
        <Show when={manages()}>
          <section class="record-section">
            <h2>Invitations</h2>
            <p class="note">
              The hub sends no email. Copy an invitation's link and send it yourself. A link works
              once, until it expires.
            </p>
            <Show when={liveInvitations().length} fallback={<p>No invitations are waiting.</p>}>
              <InvitationAddressNote />
              <table class="records is-fit" role="table">
                <caption class="vh">Invitations</caption>
                <TableHead columns={["Email", "Role", "Invited by", "Expires"]} />
                <tbody role="rowgroup">
                  <For each={liveInvitations()} keyed={(i) => i.id}>
                    {(invite) => (
                      <tr role="row">
                        <td class="is-id mono" role="cell">
                          {invite().email}
                        </td>
                        <td data-l="Role" role="cell">
                          {roleLabel(invite().role)}
                        </td>
                        <td data-l="Invited by" role="cell">
                          {invite().inviter.id === context().user.id
                            ? "you"
                            : invite().inviter.name}
                        </td>
                        <td data-l="Expires" role="cell">
                          <Instant value={invite().expiresAt} />
                        </td>
                        <td class="is-act" role="cell">
                          <div class="controls">
                            <CopyButton
                              showTextOnFailure
                              label="Copy link"
                              accessibleLabel={`Copy link for ${invite().email}`}
                              text={invitationLink(invite().id).href}
                            />
                            <AlertDialogTrigger
                              controller={confirmRevoke}
                              payload={{
                                id: invite().id,
                                email: invite().email,
                                role: invite().role,
                              }}
                              class="danger"
                              aria-label={`Revoke the invitation for ${invite().email}`}
                            >
                              Revoke
                            </AlertDialogTrigger>
                          </div>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </section>
        </Show>
      </Show>
      {/* Outside every Show a read switches, so a read that drops a record or withdraws its control
          keeps its dialog, and a refusal or an answer still to come has somewhere to show. */}
      <InviteMember
        controller={inviteDialog}
        withdrawn={() => (canInviteOrRename() ? undefined : MANAGERS_ONLY)}
        owner={owner()}
        organizationId={orgId()}
        refreshInvites={() => void refreshInvites()}
        refreshSession={() => void refreshSession()}
      />
      <RenameOrganization
        controller={renameDialog}
        withdrawn={() =>
          canInviteOrRename() ? undefined : "Only owners and admins rename the Organization."
        }
        name={org()?.name ?? ""}
        rename={rename}
        notice={() => noticeElement}
      />
      <ChangeRole
        controller={changeRoleDialog}
        owner={rolesOf(roster().members.find(isOwn)?.role ?? "").includes("owner")}
        own={isOwn}
        current={currentMember}
        withdrawn={roleChangeWithdrawn}
        refusal={roleChangeRefusal}
        change={changeRole}
        consequences={consequences}
        notice={() => noticeElement}
      />
      <ConfirmDialog
        controller={confirmRemove}
        heading={({ member, organization }) => `Remove ${member.user.name} from ${organization}?`}
        keep="Keep them"
        confirm={({ member }) => `Remove ${member.user.name}`}
        withdrawn={removalWithdrawn}
        refusal={removalRefusal}
        act={remove}
        notice={() => noticeElement}
      >
        {({ member }, pending) => (
          <>
            <p>
              They can no longer read or change anything here, from now on. Jobs and Batches they
              submitted stay, and running ones carry on.
            </p>
            {consequences(member, "remove", pending)}
            <p>
              Their account stays: they can sign in but see nothing of the Organization, and can be
              invited back.
            </p>
          </>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        controller={confirmLeave}
        heading={({ organization }) => `Leave ${organization}?`}
        keep="Stay"
        confirm={({ organization }) => `Leave ${organization}`}
        withdrawn={leaveWithdrawn}
        act={leave}
        notice={() => noticeElement}
      >
        {({ member }) => (
          <>
            <p>
              You can no longer read or change anything here. Jobs and Batches you submitted stay,
              and running ones carry on.
            </p>
            {consequences(member, "leave")}
            <p>Your account stays. Only an owner or admin can invite you back.</p>
          </>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        controller={confirmRevoke}
        heading={(invite) => (
          <>
            Revoke the invitation for <span class="mono">{invite.email}</span>?
          </>
        )}
        confirm={(invite) => `Revoke the invitation for ${invite.email}`}
        withdrawn={revocationWithdrawn}
        act={revoke}
        notice={() => noticeElement}
      >
        {() => (
          <p>
            Its link stops working at once. Final: to invite them again, create a new invitation.
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}
