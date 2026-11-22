import { BetterFetchError } from "@better-fetch/fetch";
import type { JSX } from "@solidjs/web";
import {
  focusManager,
  noop,
  useMutation,
  useQuery,
  useQueryClient,
  type DataTag,
  type QueryKey,
} from "@tanstack/solid-query";
import { Link, createFileRoute, useRouter } from "@tanstack/solid-router";
import { AlertDialogTrigger, createAlertDialogController } from "@ui-sdk/solid/alert-dialog";
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
  onSettled,
} from "solid-js";

import { api, hubFailureDetail, hubFailureMessage, readFromHub } from "../../../api-client.ts";
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
import { focusIfLost } from "../../../form.ts";
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
import { orpc } from "../../../query.ts";

export const Route = createFileRoute("/_signed-in/_member/organization")({
  head: ({ match }) => memberPageHead(match.context, "Organization"),
  loader: async ({ context: { member, queryClient, managesKeys } }) => {
    if (!member) return;
    await Promise.all([
      readFromHub("The members", () =>
        queryClient.query({ ...membersOptions(member.organization.id), staleTime: "static" }),
      ),
      managesKeys &&
        readFromHub("The invitations", () =>
          queryClient.query({ ...invitationsOptions(member.role), staleTime: "static" }),
        ),
      // Wait for counts, but let the page show a failed keys read alongside the roster.
      managesKeys &&
        queryClient.query(orpc.apiKeys.list.queryOptions({ staleTime: "static" })).catch(noop),
    ]);
  },
  errorComponent: (props) => <ReadErrorPage {...props} heading="Organization" />,
  component: Organization,
});

/** An invitation to revoke, as the page showed it when Revoke was pressed. */
type Revocation = { id: string; email: string; expiresAt: Date };

const MANAGERS_ONLY = "Only owners and admins invite members, change roles and remove members.";

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
  const [form, setForm] = createSignal<"rename" | "invite">();
  const [notice, setNotice] = createSignal<{
    role: "alert" | "status";
    message: JSX.Element;
    focusRef?: (element: HTMLDivElement) => void;
  }>();
  // For a confirmation's focus once the page shows its outcome.
  let noticeElement: HTMLElement | undefined;
  const report = (message: JSX.Element) =>
    setNotice({
      role: "alert",
      message,
      focusRef: (element) => onSettled(() => focusIfLost(element)),
    });
  const status = (message: JSX.Element) => setNotice({ role: "status", message });
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
  let readingSession: Promise<void> | undefined;
  const refreshSession = () =>
    (readingSession ??= router.invalidate().finally(() => {
      readingSession = undefined;
    }));
  const isOwn = (person: Member) => person.userId === context().user.id;
  // A background member read may discover a change in another tab.
  createEffect(
    () => ({
      readerRole: roster().members.find(isOwn)?.role,
      error: members.error,
    }),
    ({ readerRole, error }) => {
      if (readerRole !== role() || isAuthAccessError(error)) {
        void refreshSession();
      }
    },
  );

  function refreshAfterMembershipChange() {
    // The inviter's authority and each key creator's membership may have changed as well.
    void refreshInvites();
    void refreshKeys();
    return refreshMembers();
  }

  /**
   * Publishes `data`, read just now, as `queryKey`'s answer, as a write's answer is: older reads of
   * it are cancelled, so none lands over it, and it is marked stale without reading it again.
   */
  async function publish<T, E>(queryKey: DataTag<QueryKey, T, E>, data: T) {
    await client.cancelQueries({ queryKey, exact: true });
    client.setQueryData(queryKey, data);
    void client.invalidateQueries({ queryKey, exact: true, refetchType: "none" });
  }

  /**
   * After Better Auth's MEMBER_NOT_FOUND, which it also answers when the reader is no member: whether
   * `person` is gone, the reader still listed and they not. One read of the members decides it while
   * the dialog waits, tried once, within Better Auth's client's deadline, offline too; Query's
   * `fetchQuery` would join a read already in flight, with its retries and its pause while offline.
   * Undefined if that read fails. A list without the reader starts the session read, as any does.
   */
  async function memberGone(organizationId: string, person: Member) {
    const current = await readMembers(organizationId).catch(() => undefined);
    if (!current) return undefined;
    await publish(membersOptions(organizationId).queryKey, current);
    return current.members.some(isOwn) && !current.members.some((m) => m.id === person.id);
  }

  /** A refused membership change: the lists are read again, and a fresh roster can withdraw it. */
  function refusedMembership(error: unknown) {
    if (isAuthAccessError(error)) void refreshSession();
    void refreshAfterMembershipChange();
  }

  const leaving = useMutation(() => ({
    mutationFn: (input: { organizationId: string }) => authClient.organization.leave(input),
  }));
  const removing = useMutation(() => ({
    mutationFn: (input: { organizationId: string; memberIdOrEmail: string }) =>
      authClient.organization.removeMember(input),
  }));
  const changingRole = useMutation(() => ({
    mutationFn: (input: { organizationId: string; memberId: string; role: MemberRole }) =>
      authClient.organization.updateMemberRole(input),
  }));
  const revokingInvitation = useMutation(() => ({
    mutationFn: (input: { invitationId: string }) =>
      authClient.organization.cancelInvitation(input),
  }));
  const renaming = useMutation(() => ({
    mutationFn: (input: { organizationId: string; data: { name: string } }) =>
      authClient.organization.update(input),
  }));

  const confirmRemove = createAlertDialogController<Member>();
  const confirmLeave = createAlertDialogController<Member>();
  const confirmRevoke = createAlertDialogController<Revocation>();

  async function remove(person: Member) {
    const organizationId = orgId();
    const name = person.user.name;
    // On its own: written beside the request, it would be held until it settles.
    onFlush(() => setNotice(undefined));
    try {
      await removing.mutate({ organizationId, memberIdOrEmail: person.id });
    } catch (error) {
      const gone = hasAuthCode(error, "MEMBER_NOT_FOUND")
        ? await memberGone(organizationId, person)
        : undefined;
      if (gone) {
        status(`${name} is already gone.`);
        // On the page before the dialog closes and focus moves to it.
        flush();
        void refreshInvites();
        void refreshKeys();
        return;
      }
      // Not gone by the list just published: the refusal stands.
      if (gone === undefined) refusedMembership(error);
      throw error;
    }
    status(`${name} is removed.`);
    // Render the outcome before starting reads that may need to retry. They start before UI SDK
    // closes the dialog, which is no matter: nothing the dialog, the notice or a row reads waits for
    // them.
    flush();
    void refreshAfterMembershipChange();
  }

  async function leave() {
    const organizationId = orgId();
    const name = org()?.name;
    // On its own: written beside the request, it would be held until it settles.
    onFlush(() => setNotice(undefined));
    try {
      await leaving.mutate({ organizationId });
    } catch (error) {
      refusedMembership(error);
      throw error;
    }
    setLeft(true);
    status(`You left ${name}.`);
    flush();
    // The session read replaces the page, and the Organization access heading takes focus from the
    // notice. It reads with its own signal, so it has no deadline, and nothing waits on it.
    void refreshSession();
  }

  async function changeRole(person: Member, next: MemberRole, close: () => boolean) {
    const own = isOwn(person);
    const name = person.user.name;
    const organizationId = orgId();
    // On its own: written beside the request, it would be held until it settles.
    onFlush(() => setNotice(undefined));
    try {
      await changingRole.mutate({ organizationId, memberId: person.id, role: next });
    } catch (error) {
      if (hasAuthCode(error, "MEMBER_NOT_FOUND") && (await memberGone(organizationId, person))) {
        // The list just published drops the row, and the dialog in it.
        setNotice({
          role: "status",
          message: `${name} is already gone.`,
          focusRef: (element) => onSettled(() => element.focus()),
        });
        void refreshInvites();
        void refreshKeys();
        return undefined;
      }
      await refreshAfterMembershipChange();
      let message = hubFailureMessage(error);
      const list = client.getQueryState(membersOptions(organizationId).queryKey);
      const fresh =
        list?.status === "success" && !list.isInvalidated ? list.data?.members : undefined;
      const reader = fresh?.find(isOwn);
      const target = fresh?.find((m) => m.id === person.id);
      if (isAuthAccessError(error) || hasAuthCode(error, "MEMBER_NOT_FOUND"))
        await refreshSession();
      if (
        hasAuthCode(
          error,
          "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER",
          "YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER",
        ) &&
        fresh &&
        soleOwner(fresh, context().user.id)
      ) {
        message = "You are now the only owner, so you cannot leave or change your own role.";
      } else if (error instanceof BetterFetchError && error.status >= 500 && fresh) {
        message = `Check the refreshed member list before trying again (${message.replace(/\.$/, "")}).`;
      }
      // Query can finish the read before the table unmounts a control that no longer applies.
      if (fresh && !(reader && target && canChangeRole(fresh, reader, target))) {
        const closed = close();
        setNotice({
          role: "alert",
          message: `Change role: ${message}`,
          focusRef: (element) => onSettled(() => (closed ? element.focus() : focusIfLost(element))),
        });
        return undefined;
      }
      return message;
    }
    const closed = close();
    if (own)
      setNotice({
        role: "status",
        message: `You are now ${asRole(next)}.`,
        focusRef: closed ? (element) => onSettled(() => element.focus()) : undefined,
      });
    else status(`${name} is now ${asRole(next)}.`);
    // Render the outcome before starting reads that may need to retry.
    flush();
    void refreshAfterMembershipChange();
    if (own) void refreshSession();
    return undefined;
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
      if (hasAuthCode(error, "INVITATION_NOT_FOUND")) {
        // One read decides whether it is already gone, as for a member: tried once, within the hub
        // deadline, offline too.
        const current = await api.invitations.list().catch(() => undefined);
        if (current) {
          await publish(queryKey, current);
          if (current.some((item) => item.id === invite.id)) throw error;
          status(<>{label} is already gone.</>);
          flush();
          return;
        }
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
  function removalWithdrawn(person: Member) {
    const list = roster().members;
    const reader = list.find(isOwn);
    const target = list.find((m) => m.id === person.id);
    if (!reader) return undefined;
    if (!target) return `${person.user.name} is no longer a member.`;
    if (canChangeRole(list, reader, target)) return undefined;
    return manager(reader) ? "Only an owner can remove an owner." : MANAGERS_ONLY;
  }

  function leaveWithdrawn() {
    return soleOwner(roster().members, context().user.id)
      ? "You are now the only owner, so you cannot leave or change your own role."
      : undefined;
  }

  function revocationWithdrawn(invite: Revocation) {
    const reader = roster().members.find(isOwn);
    if (!manages() || (reader && !manager(reader)))
      return "Only owners and admins can revoke invitations.";
    // The hub lists live invitations alone, so one missing from a read made after it expired may
    // simply have expired, and can still be revoked.
    const listed = invitationList().some((item) => item.id === invite.id);
    if (!listed && invite.expiresAt.getTime() > invitations.dataUpdatedAt)
      return "This invitation is no longer pending.";
    return undefined;
  }

  function consequences(person: Member, next: MemberRole | "remove" | "leave") {
    if (!manages() || person.role === next) return undefined;
    const own = isOwn(person);
    const sent = liveInvitations().filter((invite) => invite.inviter.id === person.userId);
    const lost =
      next === "admin"
        ? sent.filter((invite) => rolesOf(invite.role).includes("owner")).length
        : next === "owner"
          ? 0
          : sent.length;
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
              Review {count === 1 ? "it" : "them"} under <Link to="/api-keys">API keys</Link>
              {count === undefined
                ? " and "
                : `, and the Runners registered with ${count === 1 ? "it" : "them"} under `}
              <Link to="/runners">Runners</Link>.
            </Show>
          </p>
        </Show>
        <Show when={lost > 0}>
          <p>
            {own ? "Your" : "Their"} {lost} pending {plural(lost, "invitation", "invitations")}
            {next === "admin" ? plural(lost, " that grants owner", " that grant owner") : ""}{" "}
            {plural(lost, "stops", "stop")} working.
          </p>
        </Show>
      </>
    );
  }

  return (
    <>
      <div class="head">
        <h1>Organization</h1>
        <Show when={manages() && !left()}>
          <div class="controls">
            <button class="primary" type="button" onClick={() => setForm("invite")}>
              Invite a member
            </button>
          </div>
        </Show>
      </div>
      <Show when={!left()}>
        <div class="org-name">
          <strong>{org()?.name}</strong>
          <Show when={manages()}>
            <button type="button" onClick={() => setForm("rename")}>
              Rename
            </button>
          </Show>
        </div>
      </Show>
      <Show when={notice()} keyed>
        {({ role: noticeRole, message, focusRef }) => (
          <Notice
            role={noticeRole}
            focusRef={(element) => {
              noticeElement = element;
              focusRef?.(element);
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
                  const [changing, setChanging] = createSignal(false);
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
                            <button
                              aria-label={
                                own() ? "Change role for yourself" : `Change role for ${name()}`
                              }
                              type="button"
                              onClick={() => setChanging(true)}
                            >
                              Change role
                            </button>
                            <Show when={changing()}>
                              <ChangeRole
                                own={own()}
                                owner={owner()}
                                name={name()}
                                role={row().role}
                                change={(next, close) => changeRole(row(), next, close)}
                                consequences={(next) => consequences(row(), next)}
                                close={() => setChanging(false)}
                                report={report}
                              />
                            </Show>
                          </Show>
                          <Show when={!own() && canChange()}>
                            <AlertDialogTrigger
                              controller={confirmRemove}
                              payload={row()}
                              class="danger"
                              aria-label={`Remove ${name()}`}
                            >
                              Remove
                            </AlertDialogTrigger>
                          </Show>
                          <Show when={own() && !onlyOwner()}>
                            <AlertDialogTrigger
                              controller={confirmLeave}
                              payload={row()}
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
                              inRow
                              label="Copy link"
                              accessibleLabel={`Copy link for ${invite().email}`}
                              text={invitationLink(invite().id).href}
                            />
                            <AlertDialogTrigger
                              controller={confirmRevoke}
                              payload={{
                                id: invite().id,
                                email: invite().email,
                                expiresAt: invite().expiresAt,
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
          <Show when={form() === "invite"}>
            <InviteMember
              owner={owner()}
              organizationId={orgId()}
              refresh={() => void refreshInvites()}
              refreshSession={refreshSession}
              close={() => setForm(undefined)}
              report={report}
            />
          </Show>
          <Show when={form() === "rename"}>
            <RenameOrganization
              name={org()?.name ?? ""}
              close={() => setForm(undefined)}
              report={report}
              rename={async (name) => {
                try {
                  const renamed = await renaming.mutate({
                    organizationId: orgId(),
                    data: { name },
                  });
                  status(`Renamed to ${renamed.name}.`);
                } finally {
                  await refreshSession();
                }
              }}
            />
          </Show>
        </Show>
      </Show>
      {/* Outside every Show a read switches, so a read that drops a record or withdraws its control
          keeps its dialog, and a refusal still to come has somewhere to show. */}
      <ConfirmDialog
        controller={confirmRemove}
        heading={(person) => `Remove ${person.user.name} from ${org()?.name}?`}
        keep={() => "Keep them"}
        confirm={(person) => `Remove ${person.user.name}`}
        withdrawn={removalWithdrawn}
        act={remove}
        notice={() => noticeElement}
      >
        {(person) => (
          <>
            <p>
              They can no longer read or change anything here, from now on. Jobs and Batches they
              submitted stay, and running ones carry on.
            </p>
            {consequences(person, "remove")}
            <p>
              Their account stays: they can sign in but see nothing of the Organization, and can be
              invited back.
            </p>
          </>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        controller={confirmLeave}
        heading={() => `Leave ${org()?.name}?`}
        keep={() => "Stay"}
        confirm={() => `Leave ${org()?.name}`}
        withdrawn={leaveWithdrawn}
        act={leave}
        notice={() => noticeElement}
      >
        {(person) => (
          <>
            <p>
              You can no longer read or change anything here. Jobs and Batches you submitted stay,
              and running ones carry on.
            </p>
            {consequences(person, "leave")}
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
