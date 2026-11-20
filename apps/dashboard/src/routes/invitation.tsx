import type { JSX } from "@solidjs/web";
import { useQuery, useQueryClient } from "@tanstack/solid-query";
import { Link, createFileRoute, useLocation, useNavigate, useRouter } from "@tanstack/solid-router";
import { problemOf } from "contract";
import { Match, Show, Switch, createEffect, createSignal, flush, onSettled } from "solid-js";

import { api, hubFailureMessage, readFromHub } from "../api-client.ts";
import { authClient, getSession } from "../auth-client.ts";
import { FailedReadNotice } from "../components/FailedReadNotice.tsx";
import { FallbackPage } from "../components/FallbackPage.tsx";
import { FieldError } from "../components/FieldError.tsx";
import { Instant } from "../components/Instant.tsx";
import { Notice } from "../components/Notice.tsx";
import { GIVEN_NAME, NEW_PASSWORD, createFormAction, fieldText, focusIfLost } from "../form.ts";
import { DATE_TIME_ZONED, formatRoles } from "../format.ts";
import {
  reloadAndWaitIfMemberChanged,
  signOutTo,
  watchDocumentMember,
} from "../member-document.ts";
import { orpc } from "../query.ts";

export const Route = createFileRoute("/invitation")({
  beforeLoad: async ({ location }) => {
    if (!location.hash) return { session: null };
    const session = await readFromHub("The session", getSession);
    await reloadAndWaitIfMemberChanged(session?.user.id ?? null);
    return { session };
  },
  pendingComponent: ReadingInvitation,
  component: Invitation,
});

function ReadingInvitation() {
  return (
    <FallbackPage heading="Invitation">
      <p class="prose" role="status">
        Reading the invitation…
      </p>
    </FallbackPage>
  );
}

function Invitation() {
  const id = useLocation({ select: (location) => location.hash });
  return (
    <Show
      when={id()}
      keyed
      fallback={
        <FallbackPage heading="Invitation">
          <p class="prose">Open the invitation link you were sent.</p>
        </FallbackPage>
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
    orpc.invitations.preview.queryOptions({ input: { invitationId: props.invitationId } });
  const preview = useQuery(previewOptions);
  const forgetPreview = () =>
    queryClient.removeQueries({ queryKey: previewOptions().queryKey, exact: true });
  createEffect(
    () => context().session?.user.id,
    (id) => {
      if (id) watchDocumentMember(id);
    },
  );
  const [joined, setJoined] = createSignal<{ organization: string; message: string }>();
  const [dead, setDead] = createSignal(false);

  return (
    <Switch fallback={<ReadingInvitation />}>
      {/* Once joined, a fresh preview answers 404. Keep the sign-in failure and the way in. */}
      <Match when={joined()}>
        {(result) => (
          <FallbackPage heading={`Joined ${result().organization}`}>
            <Notice role="alert">{result().message}</Notice>
            <p>
              <Link class="stands-alone" to="/sign-in" ref={focusSignIn}>
                Sign in
              </Link>
            </p>
          </FallbackPage>
        )}
      </Match>
      <Match when={dead() || (preview.isError && problemOf(preview.error)?.status === 404)}>
        <FallbackPage heading="Invitation">
          <p class="prose">
            This invitation is no longer available. It may have been used, revoked or replaced, or
            have expired. Ask whoever invited you for a new one.
          </p>
          <p>
            <Show
              when={context().session}
              fallback={
                <Link class="stands-alone" to="/sign-in">
                  Sign in
                </Link>
              }
            >
              <Link class="stands-alone" to="/">
                Go to the dashboard
              </Link>
            </Show>
          </p>
        </FallbackPage>
      </Match>
      <Match when={preview.isLoadingError}>
        <FallbackPage heading="Invitation">
          <Notice role="alert">
            The invitation could not be read: {hubFailureMessage(preview.error)}
          </Notice>
          <p>
            <button type="button" class="primary" onClick={() => void preview.refetch()}>
              Try again
            </button>
          </p>
        </FallbackPage>
      </Match>
      <Match when={preview.dataUpdatedAt}>
        <AcceptInvitation
          invitationId={props.invitationId}
          invitation={preview.data}
          consumed={forgetPreview}
          unavailable={async () => {
            forgetPreview();
            // The invitation may have been used in another tab that also changed the session.
            await router.invalidate();
            setDead(true);
          }}
          joined={setJoined}
        >
          <Show when={preview.isRefetchError}>
            <FailedReadNotice
              what="The invitation"
              detail={hubFailureMessage(preview.error)}
              failedAt={preview.errorUpdatedAt}
              readAt={preview.dataUpdatedAt}
            />
          </Show>
        </AcceptInvitation>
      </Match>
    </Switch>
  );
}

function focusSignIn(link: HTMLAnchorElement) {
  onSettled(() => focusIfLost(link));
}

function AcceptInvitation(props: {
  invitationId: string;
  invitation: Awaited<ReturnType<typeof api.invitations.preview>>;
  consumed: () => void;
  unavailable: () => Promise<void>;
  children: JSX.Element;
  joined: (result: { organization: string; message: string }) => void;
}) {
  const context = Route.useRouteContext();
  const session = () => context().session;
  const differentAccount = () =>
    Boolean(session() && session()?.user.email !== props.invitation.email);
  const navigate = useNavigate();
  const [error, setError] = createSignal<string>();
  const [offerSignIn, setOfferSignIn] = createSignal(false);
  const [passwordError, setPasswordError] = createSignal<string>();
  let password: HTMLInputElement | undefined;
  const [needsSignIn, setNeedsSignIn] = createSignal(false);
  const { pending, onSubmit } = createFormAction(async (element) => {
    setError(undefined);
    setPasswordError(undefined);
    setOfferSignIn(false);
    if (differentAccount()) {
      try {
        await signOutTo();
      } catch (failure) {
        setError(hubFailureMessage(failure));
      }
      return;
    }

    const form = new FormData(element);
    const account = session()
      ? undefined
      : { name: fieldText(form, "name"), password: fieldText(form, "password") };
    const organization = props.invitation.organizationName;
    let joined;
    try {
      joined = await api.invitations.accept({ invitationId: props.invitationId, ...account });
    } catch (failure) {
      const status = problemOf(failure)?.status;
      if (status === 404) {
        await props.unavailable();
        return;
      }
      if (status === 401) {
        setNeedsSignIn(true);
        return;
      }
      const message = hubFailureMessage(failure);
      // Invitation refusals carry the hub's detail, without Better Auth's field error code.
      if (
        account &&
        status === 400 &&
        (message === "Password too long" || message === "Password too short")
      ) {
        if (password?.value === account.password) {
          setPasswordError(message);
          flush();
          password.focus();
        }
      } else {
        setError(message);
        setOfferSignIn(status === 422);
      }
      return;
    }
    props.consumed();
    if (account) {
      try {
        await authClient.signIn.email({ email: joined.email, password: account.password });
      } catch (failure) {
        props.joined({
          organization,
          message: `Your account was created and you have joined ${organization}, but signing in failed: ${hubFailureMessage(failure)}`,
        });
        return;
      }
    }
    await navigate({ to: "/" });
  });

  const join = () => `Join ${props.invitation.organizationName}`;
  const signInSearch = { redirect: "/invitation" };
  return (
    <FallbackPage heading={differentAccount() ? "Invitation" : join()}>
      {props.children}
      <Switch>
        <Match when={needsSignIn()}>
          <Notice role="alert">
            An account with <span class="mono">{props.invitation.email}</span> already exists. Sign
            in with it to join.
          </Notice>
          <p>
            <Link class="stands-alone" to="/sign-in" search={signInSearch} hash ref={focusSignIn}>
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
            <Show when={error()}>{(message) => <Notice role="alert">{message()}</Notice>}</Show>
            <button type="submit" disabled={pending()}>
              Sign out to use it
            </button>
          </form>
        </Match>
        <Match when={true}>
          <p class="prose">
            <Show when={session()}>
              {(signedIn) => (
                <>
                  You are signed in as <span class="mono">{signedIn().user.email}</span>.{" "}
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
              <div class="field">
                <label for="join-email">Email</label>
                <input
                  id="join-email"
                  name="email"
                  type="email"
                  autocomplete="username"
                  class="mono"
                  readonly
                  value={props.invitation.email}
                />
              </div>
              <div class="field">
                <label for="join-name">Your name</label>
                <input id="join-name" name="name" autocomplete="name" required {...GIVEN_NAME} />
              </div>
              <div class="field">
                <label for="join-password">Password</label>
                <input
                  id="join-password"
                  name="password"
                  type="password"
                  autocomplete="new-password"
                  required
                  {...NEW_PASSWORD}
                  aria-invalid={passwordError() ? "true" : undefined}
                  aria-describedby={passwordError() ? "join-password-error" : undefined}
                  onInput={() => setPasswordError(undefined)}
                  ref={(input) => {
                    password = input;
                  }}
                />
                <Show when={passwordError()}>
                  {(message) => <FieldError id="join-password-error">{message()}</FieldError>}
                </Show>
              </div>
            </Show>
            <Show when={error()}>{(message) => <Notice role="alert">{message()}</Notice>}</Show>
            <button type="submit" class="primary" disabled={pending()}>
              {session() ? join() : "Create account and join"}
            </button>
          </form>
          <Show when={!session() || offerSignIn()}>
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
      <Show when={pending()}>
        <p role="status" class="note">
          Working…
        </p>
      </Show>
    </FallbackPage>
  );
}
