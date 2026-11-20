import { BetterFetchError } from "@better-fetch/fetch";
import type { JSX } from "@solidjs/web";
import { For, Show, createSignal, createUniqueId, onSettled } from "solid-js";

import { hubFailureMessage } from "../api-client.ts";
import { authClient } from "../auth-client.ts";
import { createFormAction, fieldText } from "../form.ts";
import { isLoopback } from "../hub-address.ts";
import { ROLE_LABEL, asRole, invitationLink, rolesOf, type MemberRole } from "../organization.ts";
import { CopyButton } from "./CopyButton.tsx";
import { FieldError } from "./FieldError.tsx";
import { Instant } from "./Instant.tsx";
import { Notice } from "./Notice.tsx";

/** Form dialogs can be closed while the hub is answering. */
function FormDialog(props: {
  heading: JSX.Element;
  confirm: string;
  children: JSX.Element;
  answered?: boolean;
  answer?: JSX.Element;
  close: () => void;
  submit: (form: FormData, close: () => boolean) => Promise<string | undefined | void>;
  report: (message: string) => void;
}) {
  const headingId = createUniqueId();
  let dialog!: HTMLDialogElement;
  const [failure, setFailure] = createSignal<string>();
  const { pending, onSubmit } = createFormAction(async (form) => {
    setFailure(undefined);
    let message;
    try {
      message = await props.submit(new FormData(form), () => {
        const open = dialog.open && dialog.isConnected;
        dialog.close();
        return open;
      });
    } catch (error) {
      message = hubFailureMessage(error);
    }
    if (message) {
      if (dialog.isConnected && dialog.open) setFailure(message);
      else props.report(`${props.confirm}: ${message}`);
    }
  });
  return (
    <dialog
      aria-labelledby={headingId}
      ref={(element) => {
        dialog = element;
        onSettled(() => element.showModal());
      }}
      onClose={props.close}
    >
      <h2 class="dialog-h" id={headingId}>
        {props.heading}
      </h2>
      <Show
        when={props.answered}
        fallback={
          <form onSubmit={onSubmit}>
            <fieldset class="dialog-b" disabled={pending()}>
              {props.children}
              <p role="status" class={pending() ? "note" : "vh"}>
                {pending() ? "Working…" : ""}
              </p>
              <Show when={failure()}>{(message) => <Notice role="alert">{message()}</Notice>}</Show>
            </fieldset>
            <div class="dialog-f">
              <button type="button" onClick={() => dialog.close()}>
                {pending() ? "Close" : "Cancel"}
              </button>
              <button type="submit" class="primary" aria-disabled={pending() ? "true" : undefined}>
                {props.confirm}
              </button>
            </div>
          </form>
        }
      >
        <form method="dialog">
          {props.answer}
          <div class="dialog-f">
            <button>Done</button>
          </div>
        </form>
      </Show>
    </dialog>
  );
}

function RoleChoices(props: {
  owner: boolean;
  own?: boolean;
  value?: string;
  choose: (role: MemberRole) => void;
}) {
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
              onChange={() => props.choose(role)}
            />
            <span>
              {ROLE_LABEL[role]}
              <small class="note">
                {role === "member"
                  ? "Submits, reads and controls jobs and Batches. Sees Runners and members."
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

type DialogProps = { close: () => void; report: (message: string) => void };

const INVITE_ROLE_REFUSED =
  "YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE" satisfies keyof typeof authClient.$ERROR_CODES;

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

export function InviteMember(
  props: DialogProps & {
    organizationId: string;
    owner: boolean;
    refresh: () => void;
    refreshSession: () => Promise<void>;
  },
) {
  const [role, setRole] = createSignal<MemberRole>("member");
  const [emailError, setEmailError] = createSignal<JSX.Element>();
  const [created, setCreated] = createSignal<{
    link: URL;
    email: string;
    role: MemberRole;
    expires: Date;
  }>();
  let emailField!: HTMLInputElement;
  async function invite(form: FormData) {
    const email = fieldText(form, "email");
    const grant = role();
    setEmailError(undefined);
    try {
      const answer = await authClient.organization.inviteMember({
        email,
        role: grant,
        organizationId: props.organizationId,
      });
      setCreated({
        link: invitationLink(answer.id),
        email: answer.email,
        role: grant,
        expires: answer.expiresAt,
      });
      props.refresh();
    } catch (error) {
      if (!(error instanceof BetterFetchError)) throw error;
      const code = error.error?.code;
      if ([401, 403].includes(error.status) || code === "MEMBER_NOT_FOUND")
        await props.refreshSession();

      const alreadyMember = code === "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION";
      // For a Member or Admin grant, this refusal refers to the invitation already at the address.
      const ownerInvitation =
        error.status === 403 && code === INVITE_ROLE_REFUSED && grant !== "owner";
      if (!alreadyMember && !ownerInvitation) throw error;
      const ownerMessage = "This address has an invitation only an owner can replace.";
      if (!emailField.isConnected)
        return alreadyMember ? `${email} is already a member.` : ownerMessage;
      if (emailField.value === email) {
        setEmailError(
          alreadyMember ? (
            <>
              <span class="mono">{email}</span> is already a member.
            </>
          ) : (
            ownerMessage
          ),
        );
      }
    }
    return undefined;
  }
  return (
    <FormDialog
      {...props}
      heading={
        <Show when={created()} fallback="Invite a member">
          {(answer) => (
            <>
              The invitation for <span class="mono">{answer().email}</span>
            </>
          )}
        </Show>
      }
      confirm="Create invitation"
      submit={invite}
      answered={!!created()}
      answer={
        <Show when={created()}>
          {(answer) => (
            <div class="dialog-b">
              <div class="copyable">
                <pre class="code wraps command" tabindex="0" aria-label="Invitation link">
                  <Show when={isLoopback(answer().link.hostname)} fallback={answer().link.origin}>
                    <mark class="placeholder">{answer().link.origin}</mark>
                  </Show>
                  {answer().link.pathname}
                  {answer().link.hash}
                </pre>
                <CopyButton
                  text={answer().link.href}
                  label="Copy the link"
                  buttonRef={(button) => onSettled(() => button.focus())}
                />
              </div>
              <InvitationAddressNote />
              <p>
                Send this link to <span class="mono">{answer().email}</span> yourself. It works
                once, until <Instant value={answer().expires} />, and lets them join as{" "}
                {asRole(answer().role)}. It stays under Invitations until then.
              </p>
            </div>
          )}
        </Show>
      }
    >
      <p class="note">
        The hub sends no email. You get a link to send them yourself. To replace an earlier
        invitation, invite the address again. Only an owner can replace a live owner invitation.
      </p>
      <div class="field">
        <label for="invite-email">Email</label>
        <input
          id="invite-email"
          name="email"
          type="email"
          required
          ref={(element) => {
            emailField = element;
          }}
          aria-invalid={emailError() ? "true" : undefined}
          aria-describedby={emailError() ? "invite-email-error" : undefined}
          onInput={() => setEmailError(undefined)}
        />
        <Show when={emailError()}>
          {(message) => <FieldError id="invite-email-error">{message()}</FieldError>}
        </Show>
      </div>
      <RoleChoices owner={props.owner} value={role()} choose={setRole} />
    </FormDialog>
  );
}

export function RenameOrganization(
  props: DialogProps & { name: string; rename: (name: string) => Promise<void> },
) {
  const startingName = props.name;
  return (
    <FormDialog
      {...props}
      heading="Rename the Organization"
      confirm="Rename"
      submit={async (form, close) => {
        await props.rename(fieldText(form, "name"));
        close();
      }}
    >
      <div class="field">
        <label for="organization-name">Name</label>
        <input id="organization-name" name="name" defaultValue={startingName} required />
      </div>
    </FormDialog>
  );
}

export function ChangeRole(
  props: DialogProps & {
    name: string;
    own: boolean;
    owner: boolean;
    role: string;
    change: (role: MemberRole, close: () => boolean) => Promise<string | undefined>;
    consequences: (role: MemberRole) => JSX.Element;
  },
) {
  // A newly read role replaces any draft based on the old one, even while this dialog stays open.
  const [choice, setChoice] = createSignal<MemberRole | undefined>(() =>
    rolesOf(props.role).find((role) => role === props.role),
  );
  const consequences = () => {
    const selected = choice();
    return selected && props.consequences(selected);
  };
  return (
    <FormDialog
      {...props}
      heading={props.own ? "Change your role" : `Change the role of ${props.name}`}
      confirm="Change role"
      submit={async (_form, close) => {
        const selected = choice();
        if (!selected) return undefined;
        if (selected === props.role) {
          close();
          return undefined;
        }
        return props.change(selected, close);
      }}
    >
      <Show when={rolesOf(props.role).length > 1}>
        <p>
          {props.own ? "Your" : "Their"} role is {rolesOf(props.role).join(" and ")} together;
          choosing one replaces {rolesOf(props.role).length === 2 ? "both" : "them all"}.
        </p>
      </Show>
      <RoleChoices owner={props.owner} own={props.own} value={choice()} choose={setChoice} />
      {consequences()}
      <Show when={props.own}>
        <p>Once you change your own role, you cannot change it back yourself.</p>
      </Show>
    </FormDialog>
  );
}
