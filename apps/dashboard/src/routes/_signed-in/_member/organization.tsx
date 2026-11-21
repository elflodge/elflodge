import { BetterFetchError } from "@better-fetch/fetch";
import type { JSX } from "@solidjs/web";
import { focusManager, noop, useQuery, useQueryClient } from "@tanstack/solid-query";
import { Link, createFileRoute, useRouter } from "@tanstack/solid-router";
import { For, Show, createEffect, createMemo, createSignal, onSettled } from "solid-js";

import { hubFailureDetail, hubFailureMessage, readFromHub } from "../../../api-client.ts";
import { authClient, hasAuthCode, isAuthAccessError } from "../../../auth-client.ts";
import { ConfirmAction } from "../../../components/ConfirmAction.tsx";
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
import { focusAfterRowDrops, focusIfLost } from "../../../form.ts";
import { plural, timeZoneNote } from "../../../format.ts";
import {
  asRole,
  invitationLink,
  invitationsOptions,
  membersOptions,
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

const rank = { owner: 0, admin: 1, member: 2 };
function roleRank(role: string) {
  return rank[rolesOf(role)[0] ?? "member"];
}

function soleOwner(list: Member[], userId: string) {
  const owners = list.filter((member) => rolesOf(member.role).includes("owner"));
  return owners.length === 1 && owners[0]?.userId === userId;
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
  const [now, setNow] = createSignal(Date.now());
  const liveInvitations = createMemo(() =>
    manages() ? invitations.data.filter((invite) => invite.expiresAt.getTime() > now()) : [],
  );
  const activeKeys = createMemo(() =>
    keys.isSuccess
      ? keys.data.filter((key) => key.expiresAt === null || key.expiresAt.getTime() > now())
      : [],
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
  const report = (message: JSX.Element) =>
    setNotice({
      role: "alert",
      message,
      focusRef: (element) => onSettled(() => focusIfLost(element)),
    });
  const status = (message: JSX.Element, stillListed?: () => boolean) =>
    setNotice({
      role: "status",
      message,
      focusRef: stillListed ? (element) => focusAfterRowDrops(element, stillListed) : undefined,
    });
  const ordered = () =>
    members.data.members.toSorted(
      (a, b) => roleRank(a.role) - roleRank(b.role) || a.user.name.localeCompare(b.user.name),
    );
  const onlyOwner = () => owner() && soleOwner(members.data.members, context().user.id);
  const refreshMembers = () =>
    client.invalidateQueries({ queryKey: membersOptions(orgId()).queryKey, exact: true });
  const refreshInvites = () => client.invalidateQueries({ queryKey: orpc.invitations.list.key() });
  let readingSession: Promise<void> | undefined;
  const refreshSession = () =>
    (readingSession ??= router.invalidate().finally(() => {
      readingSession = undefined;
    }));
  const isOwn = (person: Member) => person.userId === context().user.id;
  // A background member read may discover a change in another tab.
  createEffect(
    () => ({
      readerRole: members.data.members.find(isOwn)?.role,
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
    void client.invalidateQueries({ queryKey: orpc.apiKeys.list.key() });
    return refreshMembers();
  }

  async function membershipAction(
    person: Member,
    next: MemberRole | "leave" | "remove",
    close?: () => boolean,
  ) {
    const own = isOwn(person);
    const name = person.user.name;
    const listed = () => members.data.members.some((m) => m.id === person.id);
    const organizationId = orgId();
    setNotice(undefined);
    try {
      if (next === "leave") await authClient.organization.leave({ organizationId });
      else if (next === "remove")
        await authClient.organization.removeMember({ organizationId, memberIdOrEmail: person.id });
      else
        await authClient.organization.updateMemberRole({
          organizationId,
          memberId: person.id,
          role: next,
        });
    } catch (error) {
      await refreshAfterMembershipChange();
      let message = hubFailureMessage(error);
      const list = client.getQueryState(membersOptions(organizationId).queryKey);
      const fresh =
        list?.status === "success" && !list.isInvalidated ? list.data?.members : undefined;
      const reader = fresh?.find(isOwn);
      const target = fresh?.find((m) => m.id === person.id);
      const memberMissing = hasAuthCode(error, "MEMBER_NOT_FOUND");
      if (isAuthAccessError(error) || memberMissing) await refreshSession();
      if (memberMissing && fresh && !target) {
        status(`${name} is already gone.`, listed);
        return undefined;
      }
      if (
        hasAuthCode(
          error,
          "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER",
          "YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER",
        )
      ) {
        if (
          next === "remove" &&
          (!fresh ||
            (reader &&
              !rolesOf(reader.role).includes("owner") &&
              target &&
              rolesOf(target.role).includes("owner")))
        ) {
          message = "Only an owner can remove an owner.";
        } else if (fresh && soleOwner(fresh, context().user.id)) {
          message = "You are now the only owner, so you cannot leave or change your own role.";
        }
      } else if (error instanceof BetterFetchError && error.status >= 500 && fresh) {
        message = `Check the refreshed member list before trying again (${message.replace(/\.$/, "")}).`;
      }
      // Query can finish the read before the table unmounts a control that no longer applies.
      const available =
        fresh &&
        reader &&
        target &&
        (next === "leave"
          ? !soleOwner(fresh, reader.userId)
          : canChangeRole(fresh, reader, target));
      if (fresh && !available) {
        const action =
          next === "leave"
            ? `Leave ${org()?.name}`
            : next === "remove"
              ? `Remove ${name}`
              : "Change role";
        const closed = close?.();
        setNotice({
          role: "alert",
          message: `${action}: ${message}`,
          focusRef: (element) => onSettled(() => (closed ? element.focus() : focusIfLost(element))),
        });
        return undefined;
      }
      return message;
    }
    if (next === "leave") {
      await refreshSession();
      return undefined;
    }
    const closed = close?.();
    if (next === "remove") status(`${name} is removed.`, listed);
    else if (own)
      setNotice({
        role: "status",
        message: `You are now ${asRole(next)}.`,
        focusRef: closed ? (element) => onSettled(() => element.focus()) : undefined,
      });
    else status(`${name} is now ${asRole(next)}.`);
    await Promise.all([refreshAfterMembershipChange(), own ? refreshSession() : undefined]);
    return undefined;
  }

  async function revoke(id: string, email: string) {
    const label = (
      <>
        The invitation for <span class="mono">{email}</span>
      </>
    );
    const listed = () => invitations.data.some((i) => i.id === id);
    const queryKey = invitationsOptions(role()).queryKey;
    setNotice(undefined);
    try {
      await authClient.organization.cancelInvitation({ invitationId: id });
    } catch (error) {
      await Promise.all([refreshMembers(), refreshInvites()]);
      const list = client.getQueryState(queryKey);
      if (
        hasAuthCode(error, "INVITATION_NOT_FOUND") &&
        list?.data &&
        !list.isInvalidated &&
        !list.data.some((item) => item.id === id)
      ) {
        status(<>{label} is already gone.</>, listed);
        return undefined;
      }
      if (isAuthAccessError(error) || hasAuthCode(error, "MEMBER_NOT_FOUND"))
        await refreshSession();
      return hubFailureMessage(error);
    }
    status(<>{label} is revoked.</>, listed);
    await refreshInvites();
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
    const count = keys.isSuccess
      ? activeKeys().filter((key) => key.creator?.id === person.userId).length
      : undefined;
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
        <Show when={manages()}>
          <div class="controls">
            <button class="primary" type="button" onClick={() => setForm("invite")}>
              Invite a member
            </button>
          </div>
        </Show>
      </div>
      <div class="org-name">
        <strong>{org()?.name}</strong>
        <Show when={manages()}>
          <button type="button" onClick={() => setForm("rename")}>
            Rename
          </button>
        </Show>
      </div>
      <Show when={notice()} keyed>
        {({ role: noticeRole, message, focusRef }) => (
          <Notice role={noticeRole} focusRef={focusRef}>
            {message}
          </Notice>
        )}
      </Show>
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
          {members.data.total} {plural(members.data.total, "member", "members")}
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
                  const reader = members.data.members.find(isOwn);
                  return (
                    manages() &&
                    reader !== undefined &&
                    canChangeRole(members.data.members, reader, row())
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
                              change={(next, close) => membershipAction(row(), next, close)}
                              consequences={(next) => consequences(row(), next)}
                              close={() => setChanging(false)}
                              report={report}
                            />
                          </Show>
                        </Show>
                        <Show when={!own() && canChange()}>
                          <ConfirmAction
                            trigger="Remove"
                            triggerLabel={`Remove ${name()}`}
                            heading={`Remove ${name()} from ${org()?.name}?`}
                            keep="Keep them"
                            confirm={`Remove ${name()}`}
                            act={(close) => membershipAction(row(), "remove", close)}
                            reportPageFailure={(message) => report(`Remove ${name()}: ${message}`)}
                          >
                            <p>
                              They can no longer read or change anything here, from now on. Jobs and
                              Batches they submitted stay, and running ones carry on.
                            </p>
                            {consequences(row(), "remove")}
                            <p>
                              Their account stays: they can sign in but see nothing of the
                              Organization, and can be invited back.
                            </p>
                          </ConfirmAction>
                        </Show>
                        <Show when={own() && !onlyOwner()}>
                          <ConfirmAction
                            trigger="Leave"
                            triggerLabel={`Leave ${org()?.name}`}
                            heading={`Leave ${org()?.name}?`}
                            keep="Stay"
                            confirm={`Leave ${org()?.name}`}
                            act={(close) => membershipAction(row(), "leave", close)}
                            reportPageFailure={(message) =>
                              report(`Leave ${org()?.name}: ${message}`)
                            }
                          >
                            <p>
                              You can no longer read or change anything here. Jobs and Batches you
                              submitted stay, and running ones carry on.
                            </p>
                            {consequences(row(), "leave")}
                            <p>Your account stays. Only an owner or admin can invite you back.</p>
                          </ConfirmAction>
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
              : "Only owners and admins invite members, change roles and remove members."}
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
                  {(invite) => {
                    const label = () => `Revoke the invitation for ${invite().email}`;
                    return (
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
                            <ConfirmAction
                              trigger="Revoke"
                              triggerLabel={label()}
                              confirm={label()}
                              heading={
                                <>
                                  Revoke the invitation for{" "}
                                  <span class="mono">{invite().email}</span>?
                                </>
                              }
                              act={() => revoke(invite().id, invite().email)}
                              reportPageFailure={(message) => report(`${label()}: ${message}`)}
                            >
                              <p>
                                Its link stops working at once. Final: to invite them again, create
                                a new invitation.
                              </p>
                            </ConfirmAction>
                          </div>
                        </td>
                      </tr>
                    );
                  }}
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
                const renamed = await authClient.organization.update({
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
    </>
  );
}
