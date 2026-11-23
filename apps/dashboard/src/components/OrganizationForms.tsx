import { BetterFetchError } from "@better-fetch/fetch";
import type { JSX } from "@solidjs/web";
import { useMutation } from "@tanstack/solid-query";
import type { DialogController } from "@ui-sdk/solid/dialog";
import { Input } from "@ui-sdk/solid/input";
import { For, Show, createMemo, createSignal, createUniqueId, untrack } from "solid-js";

import { HUB_DEADLINE_MS } from "../api-client.ts";
import { authClient, hasAuthCode, isAuthAccessError } from "../auth-client.ts";
import { fieldText, type FormRefusal } from "../form.ts";
import { isLoopback } from "../hub-address.ts";
import {
  ROLE_LABEL,
  asRole,
  invitationLink,
  rolesOf,
  type Member,
  type MemberRole,
} from "../organization.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Field } from "./Field.tsx";
import { FormDialog } from "./FormDialog.tsx";
import { Instant } from "./Instant.tsx";

/** The role a form's checked Role choice names; the choices are required, so one is checked. */
function chosenRole(form: FormData): MemberRole | undefined {
  return rolesOf(fieldText(form, "role"))[0];
}

function RoleChoices(props: {
  owner: boolean;
  own?: boolean;
  value?: string;
  choose?: (role: MemberRole) => void;
}) {
  // A click on the Role legend leaves focus on the dialog. FieldGroup would focus the group itself.
  return (
    <fieldset class="field">
      <legend>Role</legend>
      <For
        each={
          props.owner ? (["member", "admin", "owner"] as const) : (["member", "admin"] as const)
        }
      >
        {(role) => (
          <label class="role-choice">
            <input
              type="radio"
              name="role"
              value={role}
              required
              checked={props.value === role}
              onChange={() => props.choose?.(role)}
            />
            <span>
              {ROLE_LABEL[role]}
              <small class="note">
                {role === "member"
                  ? "Submits, reads and controls jobs and Batches. Each job spends money on models. Sees Runners and members."
                  : role === "admin"
                    ? "Also manages API keys, reads Usage, removes Runners, invites and removes members and changes their roles, owners excepted."
                    : `Also invites, changes and removes owners${props.own ? "." : ", you included."}`}
              </small>
            </span>
          </label>
        )}
      </For>
    </fieldset>
  );
}

export function InvitationAddressNote() {
  return (
    <Show when={isLoopback(window.location.hostname)}>
      <p class="note">
        This page's address reaches the hub only from this machine. Replace it with the address the
        invited person will use.
      </p>
    </Show>
  );
}

export function InviteMember(props: {
  controller: DialogController;
  withdrawn: () => string | undefined;
  organizationId: string;
  owner: boolean;
  refreshInvites: () => void;
  refreshSession: () => void;
}) {
  const inviting = useMutation(() => ({
    mutationFn: (input: { email: string; role: MemberRole; organizationId: string }) =>
      // Better Auth's client has no deadline of its own, and the dialog waits for this call.
      authClient.organization.inviteMember({
        ...input,
        fetchOptions: { timeout: HUB_DEADLINE_MS },
      }),
  }));
  const instructionsId = createUniqueId();
  async function invite(element: HTMLFormElement) {
    const form = new FormData(element);
    const email = fieldText(form, "email");
    const role = chosenRole(form) ?? "member";
    try {
      const answer = await inviting.mutate({
        email,
        role,
        organizationId: props.organizationId,
      });
      return {
        link: invitationLink(answer.id),
        email: answer.email,
        role,
        expires: answer.expiresAt,
      };
    } catch (error) {
      if (isAuthAccessError(error) || hasAuthCode(error, "MEMBER_NOT_FOUND"))
        props.refreshSession();
      throw error;
    } finally {
      // Also after a failure that is not a refusal, which may come after the invitation was made.
      props.refreshInvites();
    }
  }
  return (
    <FormDialog
      controller={props.controller}
      heading={() => "Invite a member"}
      confirm="Create invitation"
      withdrawn={props.withdrawn}
      refusal={(error) => {
        let message;
        if (hasAuthCode(error, "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION"))
          message = "This address is already a member.";
        // For a Member or Admin grant, this refusal refers to the invitation already at the address.
        else if (
          hasAuthCode(error, "YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE") &&
          error instanceof BetterFetchError &&
          error.status === 403 &&
          inviting.variables?.role !== "owner"
        )
          message = "This address has an invitation only an owner can replace.";
        if (message) return { fields: new Map([["email", message]]), alert: undefined };
        return undefined;
      }}
      send={invite}
      answer={{
        heading: (created) => (
          <>
            The invitation for <span class="mono">{created.email}</span>
          </>
        ),
        children: (created, focus) => (
          <>
            <div class="copyable">
              <pre class="code wraps command" tabindex="0" aria-label="Invitation link">
                <Show when={isLoopback(created.link.hostname)} fallback={created.link.origin}>
                  <mark class="placeholder">{created.link.origin}</mark>
                </Show>
                {created.link.pathname}
                {created.link.hash}
              </pre>
              <CopyButton
                text={created.link.href}
                label="Copy the link"
                describedBy={instructionsId}
                buttonRef={focus.buttonRef}
              />
            </div>
            <InvitationAddressNote />
            <p id={instructionsId}>
              Send this link to <span class="mono">{created.email}</span> yourself. It works once,
              until <Instant value={created.expires} />, and lets them join as{" "}
              {asRole(created.role)}. It stays under Invitations until then.
            </p>
          </>
        ),
      }}
    >
      {(fields) => (
        <>
          <p class="note">
            The hub sends no email. You get a link to send them yourself. To replace an earlier
            invitation, invite the address again. Only an owner can replace an invitation that
            grants owner.
          </p>
          <Field label="Email" error={fields.refused("email")}>
            <Input name="email" type="email" required readonly={fields.pending()} />
          </Field>
          <RoleChoices owner={props.owner} value="member" />
        </>
      )}
    </FormDialog>
  );
}

export function RenameOrganization(props: {
  controller: DialogController;
  withdrawn: () => string | undefined;
  name: string;
  rename: (name: string) => Promise<void>;
  notice: () => HTMLElement | undefined;
}) {
  return (
    <FormDialog
      controller={props.controller}
      heading={() => "Rename the Organization"}
      confirm="Rename"
      withdrawn={props.withdrawn}
      send={(form) => props.rename(fieldText(new FormData(form), "name"))}
      notice={props.notice}
    >
      {(fields) => (
        <Field label="Name">
          <Input
            name="name"
            // The name as the dialog opens; a session read while it is open leaves the draft.
            defaultValue={untrack(() => props.name)}
            required
            readonly={fields.pending()}
          />
        </Field>
      )}
    </FormDialog>
  );
}

/**
 * The role of the member the dialog opened for, one for the members list. What it reads of them while
 * open comes from `current`, the roster as last read, and `member` as at the press when the
 * roster no longer lists them.
 */
export function ChangeRole(props: {
  controller: DialogController<Member>;
  owner: boolean;
  own: (member: Member) => boolean;
  current: (member: Member) => Member;
  withdrawn: (member: Member) => string | undefined;
  change: (member: Member, role: MemberRole) => Promise<void>;
  refusal: (error: unknown) => FormRefusal | undefined;
  consequences: (member: Member, role: MemberRole) => JSX.Element;
  notice: () => HTMLElement | undefined;
}) {
  return (
    <FormDialog
      controller={props.controller}
      heading={(member) =>
        props.own(member)
          ? "Change your role"
          : `Change the role of ${props.current(member).user.name}`
      }
      confirm="Change role"
      withdrawn={props.withdrawn}
      refusal={props.refusal}
      send={async (form, member) => {
        const current = props.current(member);
        const role = chosenRole(new FormData(form));
        // The role the member has now sends nothing.
        if (!role || role === current.role) return false;
        return props.change(current, role);
      }}
      notice={props.notice}
    >
      {(_fields, member) => (
        <RoleFields
          member={props.current(member)}
          own={props.own(member)}
          owner={props.owner}
          consequences={props.consequences}
        />
      )}
    </FormDialog>
  );
}

function RoleFields(props: {
  member: Member;
  own: boolean;
  owner: boolean;
  consequences: (member: Member, role: MemberRole) => JSX.Element;
}) {
  const role = createMemo(() => props.member.role);
  // A newly read role replaces any draft based on the old one, even while this dialog stays open.
  const [choice, setChoice] = createSignal<MemberRole | undefined>(() =>
    rolesOf(role()).find((each) => each === role()),
  );
  const consequences = () => {
    const selected = choice();
    return selected && props.consequences(props.member, selected);
  };
  return (
    <>
      <Show when={rolesOf(role()).length > 1}>
        <p>
          {props.own ? "Your" : "Their"} role is {rolesOf(role()).join(" and ")} together; choosing
          one replaces {rolesOf(role()).length === 2 ? "both" : "them all"}.
        </p>
      </Show>
      <RoleChoices owner={props.owner} own={props.own} value={choice()} choose={setChoice} />
      {consequences()}
      <Show when={props.own}>
        <p>Once you change your own role, you cannot change it back yourself.</p>
      </Show>
    </>
  );
}
