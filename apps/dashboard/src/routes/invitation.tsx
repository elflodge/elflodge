import type { JSX } from "@solidjs/web";
import { focusManager, useQuery, useQueryClient } from "@tanstack/solid-query";
import { Link, createFileRoute, useLocation, useNavigate, useRouter } from "@tanstack/solid-router";
import { Button } from "@ui-sdk/solid/button";
import { FieldControl } from "@ui-sdk/solid/field";
import { Input } from "@ui-sdk/solid/input";
import { INVITATION_HEADER, PASSWORD_LENGTH, problemOf } from "contract";
import {
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  deep,
  latest,
  onSettled,
} from "solid-js";

import {
  api,
  HUB_DEADLINE_MS,
  failureDetailSuffix,
  hubFailureDetail,
  hubFailureMessage,
  readFromHub,
} from "../api-client.ts";
import { authClient, getSession, hasAuthCode, isSignedOutError } from "../auth-client.ts";
import { BrandMark } from "../components/BrandMark.tsx";
import { FailedReadNotice } from "../components/FailedReadNotice.tsx";
import { Field } from "../components/Field.tsx";
import { Instant } from "../components/Instant.tsx";
import { Notice } from "../components/Notice.tsx";
import {
  GIVEN_NAME,
  NEW_PASSWORD,
  createFormAction,
  fieldText,
  focusIfLost,
  settledRef,
} from "../form.ts";
import { DATE_TIME_ZONED, formatRoles } from "../format.ts";
import {
  reloadAndWaitIfMemberChanged,
  signOutTo,
  watchDocumentMember,
} from "../member-document.ts";
import { pageHead } from "../page-title.ts";
import { orpc } from "../query.ts";

export const Route = createFileRoute("/invitation")({
  head: () => pageHead("Invitation"),
  beforeLoad: async ({ location }) => {
    if (!location.hash) return { session: null };
    return { session: await readFromHub("The session", readInvitationSession) };
  },
  pendingComponent: ReadingInvitation,
  component: Invitation,
});

async function readInvitationSession() {
  const session = await getSession();
  await reloadAndWaitIfMemberChanged(session?.user.id ?? null);
  return session;
}

function InvitationPage(props: { heading: string; children: JSX.Element }) {
  return (
    <main id="main" class="page is-alone">
      <BrandMark alt="" />
      <h1>{props.heading}</h1>
      {props.children}
    </main>
  );
}

function ReadingInvitation() {
  return (
    <InvitationPage heading="Invitation">
      <p class="prose" role="status">
        Reading the invitation…
      </p>
    </InvitationPage>
  );
}

function Invitation() {
  const id = useLocation({ select: (location) => location.hash });
  return (
    <Show
      when={id()}
      keyed
      fallback={
        <InvitationPage heading="Invitation">
          <p class="prose">Open the invitation link you were sent.</p>
        </InvitationPage>
      }
    >
      {(invitationId) => <ReadInvitation invitationId={invitationId} />}
    </Show>
  );
}

function ReadInvitation(props: { invitationId: string }) {
  const context = Route.useRouteContext();
  const router = useRouter();
  const queryClient = useQueryClient();
  const previewOptions = () =>
    orpc.invitations.preview.queryOptions({
      input: { invitationId: props.invitationId },
      refetchOnWindowFocus: "always",
    });
  const preview = useQuery(previewOptions);
  const invitation = createMemo(() => latest(() => deep(preview.data)));
  const onFocus = () => {
    void router.invalidate();
    void preview.refetch({ cancelRefetch: false });
  };
  onSettled(() => {
    // Query refreshes the preview when a tab becomes visible. Two visible windows can also
    // exchange focus after sign-in, without a visibility change.
    const unsubscribe = focusManager.subscribe((focused) => {
      if (focused) void router.invalidate();
    });
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      unsubscribe();
    };
  });
  const forgetPreview = () =>
    queryClient.removeQueries({ queryKey: previewOptions().queryKey, exact: true });
  createEffect(
    () => context().session?.user.id,
    (id) => {
      if (id) watchDocumentMember(id);
    },
  );
  const [dead, setDead] = createSignal(false);

  return (
    <Switch fallback={<ReadingInvitation />}>
      <Match when={dead() || (preview.isError && problemOf(preview.error)?.status === 404)}>
        <UnavailableInvitation focusLink={dead()} />
      </Match>
      <Match when={preview.isLoadingError}>
        <InvitationPage heading="Invitation">
          <Notice role="alert">
            The invitation could not be read{failureDetailSuffix(hubFailureDetail(preview.error))}
          </Notice>
          <p>
            <Button class="primary" onClick={() => preview.refetch()}>
              Try again
            </Button>
          </p>
        </InvitationPage>
      </Match>
      <Match when={preview.dataUpdatedAt}>
        <AcceptInvitation
          invitationId={props.invitationId}
          invitation={invitation()}
          consumed={forgetPreview}
          unavailable={() => {
            forgetPreview();
            setDead(true);
          }}
        >
          <Show when={preview.isRefetchError}>
            <FailedReadNotice
              what="The invitation"
              detail={hubFailureDetail(preview.error)}
              failedAt={preview.errorUpdatedAt}
              readAt={preview.dataUpdatedAt}
            />
          </Show>
        </AcceptInvitation>
      </Match>
    </Switch>
  );
}

function UnavailableInvitation(props: { focusLink: boolean }) {
  const router = useRouter();
  const context = Route.useRouteContext();
  const [checked, setChecked] = createSignal(false);
  // Either the preview or the press can discover that another tab already joined.
  onSettled(() => {
    void router.invalidate().then(() => setChecked(true));
  });
  return (
    <InvitationPage heading="Invitation">
      <p class="prose">
        This invitation is no longer available. It may have been used or revoked, or have expired.
        Ask an Organization owner or admin for a new invitation. Only an owner can invite another
        owner.
      </p>
      <p>
        <Show when={checked()}>
          <Show
            when={context().session}
            fallback={
              <Link
                class="stands-alone"
                to="/sign-in"
                ref={settledRef((link: HTMLAnchorElement) => {
                  if (props.focusLink) focusIfLost(link);
                })}
              >
                Sign in
              </Link>
            }
          >
            <Link
              class="stands-alone"
              to="/"
              ref={settledRef((link: HTMLAnchorElement) => {
                if (props.focusLink) focusIfLost(link);
              })}
            >
              Go to the dashboard
            </Link>
          </Show>
        </Show>
      </p>
    </InvitationPage>
  );
}

function AcceptInvitation(props: {
  invitationId: string;
  invitation: Awaited<ReturnType<typeof api.invitations.preview>>;
  consumed: () => void;
  unavailable: () => void;
  children: JSX.Element;
}) {
  const context = Route.useRouteContext();
  const session = () => context().session;
  const differentAccount = () =>
    Boolean(session() && session()?.user.email !== props.invitation.email);
  const navigate = useNavigate();
  const [error, setError] = createSignal<string>();
  const router = useRouter();
  const [passwordError, setPasswordError] = createSignal<string>();
  let password: HTMLInputElement | undefined;
  // A returning invitee may sign in from another tab.
  const [refusedAccount, setRefusedAccount] = createSignal<string | null>();
  const accountId = () => session()?.user.id ?? null;
  const { pending, onSubmit } = createFormAction(async (element) => {
    setError(undefined);
    setPasswordError(undefined);
    if (differentAccount()) {
      try {
        await signOutTo();
      } catch (failure) {
        setError(hubFailureMessage(failure));
      }
      return;
    }

    const form = new FormData(element);
    const submittedBy = accountId();
    try {
      if (!session()) {
        await authClient.signUp.email({
          email: props.invitation.email,
          name: fieldText(form, "name"),
          password: fieldText(form, "password"),
          fetchOptions: {
            timeout: HUB_DEADLINE_MS,
            headers: { [INVITATION_HEADER]: props.invitationId },
          },
        });
      }
      await authClient.organization.acceptInvitation({
        invitationId: props.invitationId,
        fetchOptions: { timeout: HUB_DEADLINE_MS },
      });
    } catch (failure) {
      if (hasAuthCode(failure, "INVITATION_NOT_FOUND")) {
        props.unavailable();
      } else if (hasAuthCode(failure, "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL")) {
        setRefusedAccount(submittedBy);
      } else if (
        hasAuthCode(failure, "PASSWORD_TOO_LONG") &&
        password?.value === fieldText(form, "password")
      ) {
        setPasswordError(`At most ${PASSWORD_LENGTH.max} characters`);
      } else {
        setError(hubFailureMessage(failure));
      }
      // Sign-up may already have established a session even when joining failed.
      if (!session() || isSignedOutError(failure)) void router.invalidate();
      return;
    }
    props.consumed();
    await navigate({ to: "/" });
  });

  const join = () => `Join ${props.invitation.organizationName}`;
  const signInSearch = { redirect: window.location.pathname };
  return (
    <InvitationPage heading={differentAccount() ? "Invitation" : join()}>
      {props.children}
      <Switch>
        <Match when={refusedAccount() === accountId()}>
          <Notice role="alert">
            An account with <span class="mono">{props.invitation.email}</span> already exists. Sign
            in with it to join.
          </Notice>
          <p>
            <Link
              class="stands-alone"
              to="/sign-in"
              search={signInSearch}
              hash
              ref={settledRef<HTMLAnchorElement>(focusIfLost)}
            >
              Sign in
            </Link>
          </p>
          <p class="prose">Forgotten its password? Whoever runs the hub can reset it.</p>
        </Match>
        <Match when={differentAccount()}>
          <p class="prose">
            This invitation is for <span class="mono">{props.invitation.email}</span>. You are
            signed in as <span class="mono">{session()?.user.email}</span>.
          </p>
          <Show when={session()?.membership.status === "member"}>
            <p class="prose">To invite them, send them this link.</p>
          </Show>
          <p>
            <Link class="stands-alone" to="/">
              Go to the dashboard
            </Link>
          </p>
          <form class="fields" onSubmit={onSubmit}>
            <Show when={error()} keyed>
              {(message) => <Notice role="alert">{message}</Notice>}
            </Show>
            <Button type="submit" disabled={pending()} focusableWhenDisabled>
              Sign out to use it
            </Button>
          </form>
        </Match>
        <Match when={true}>
          <p class="prose">
            <Show when={session()} keyed>
              {(signedIn) => (
                <>
                  You are signed in as <span class="mono">{signedIn.user.email}</span>.{" "}
                </>
              )}
            </Show>
            This invitation lets{" "}
            {session() ? "you" : <span class="mono">{props.invitation.email}</span>} join{" "}
            {props.invitation.organizationName} with {formatRoles(props.invitation.role)} access. It
            works once, until{" "}
            <Instant value={props.invitation.expiresAt} format={DATE_TIME_ZONED} />.
          </p>
          <form class="fields" onSubmit={onSubmit}>
            <Show when={!session()}>
              <Field label="Email">
                <Input
                  name="email"
                  type="email"
                  autocomplete="username"
                  class="mono"
                  readonly
                  defaultValue={props.invitation.email}
                />
              </Field>
              <Field label="Your name">
                <Input name="name" autocomplete="name" required {...GIVEN_NAME} />
              </Field>
              <Field label="Password" error={passwordError()}>
                <FieldControl
                  name="password"
                  type="password"
                  autocomplete="new-password"
                  required
                  {...NEW_PASSWORD}
                  onInput={() => setPasswordError(undefined)}
                  ref={(input) => {
                    password = input;
                  }}
                />
              </Field>
            </Show>
            <Show when={error()} keyed>
              {(message) => <Notice role="alert">{message}</Notice>}
            </Show>
            <Button type="submit" class="primary" disabled={pending()} focusableWhenDisabled>
              {session() ? join() : "Create account and join"}
            </Button>
          </form>
          <Show when={!session()}>
            <p class="prose">
              Already have an account here with this address?{" "}
              <Link to="/sign-in" search={signInSearch} hash>
                Sign in to join
              </Link>
              .
            </p>
          </Show>
        </Match>
      </Switch>
      <p role="status" class={pending() ? "note" : "vh"}>
        {pending() ? "Working…" : ""}
      </p>
    </InvitationPage>
  );
}
