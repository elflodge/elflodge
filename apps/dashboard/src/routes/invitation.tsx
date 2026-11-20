import { useQuery } from "@tanstack/solid-query";
import { Link, createFileRoute, useLocation, useNavigate } from "@tanstack/solid-router";
import { problemOf } from "contract";
import { Match, Show, Switch, createSignal, onSettled } from "solid-js";

import { api, hubFailureMessage, readFromHub } from "../api-client.ts";
import { authClient, getSession } from "../auth-client.ts";
import { FallbackPage } from "../components/FallbackPage.tsx";
import { Instant } from "../components/Instant.tsx";
import { Notice } from "../components/Notice.tsx";
import { GIVEN_NAME, NEW_PASSWORD, createFormAction, fieldText, focusIfLost } from "../form.ts";
import { DATE_TIME_ZONED } from "../format.ts";
import { reloadAndWaitIfMemberChanged, signOutTo } from "../member-document.ts";
import { orpc } from "../query.ts";

export const Route = createFileRoute("/invitation")({
  beforeLoad: async ({ location }) => {
    if (!location.hash) return { session: null };
    const session = await readFromHub("The session", getSession);
    await reloadAndWaitIfMemberChanged(session?.user.id ?? null);
    return { session };
  },
  pendingMs: 0,
  pendingMinMs: 0,
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
  const preview = useQuery(() => orpc.invitations.preview.queryOptions({ input: props }));
  const [joined, setJoined] = createSignal<{ organization: string; message: string }>();
  const [dead, setDead] = createSignal(false);

  return (
    <Switch fallback={<ReadingInvitation />}>
      {/* Once joined, a fresh preview answers 404. Keep the sign-in failure and the way in. */}
      <Match when={joined()}>
        {(result) => (
          <FallbackPage heading={`Join ${result().organization}`}>
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
      <Match when={preview.isError}>
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
      <Match when={preview.isSuccess}>
        <AcceptInvitation
          invitationId={props.invitationId}
          invitation={preview.data}
          unavailable={() => setDead(true)}
          joined={setJoined}
        />
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
  unavailable: () => void;
  joined: (result: { organization: string; message: string }) => void;
}) {
  const context = Route.useRouteContext();
  const session = () => context().session;
  const differentAccount = () =>
    Boolean(session() && session()?.user.email !== props.invitation.email);
  const navigate = useNavigate();
  const [error, setError] = createSignal<string>();
  const [needsSignIn, setNeedsSignIn] = createSignal(false);
  const { pending, onSubmit } = createFormAction(async (element) => {
    setError(undefined);
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
        props.unavailable();
        return;
      }
      if (status === 401 || status === 422) {
        const prompt = `An account with ${props.invitation.email} already exists. Sign in with it to join.`;
        setError(status === 401 ? prompt : `${hubFailureMessage(failure)}. ${prompt}`);
        setNeedsSignIn(true);
      } else {
        setError(hubFailureMessage(failure));
      }
      return;
    }
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
  const role = () => props.invitation.role.replaceAll(",", ", ");
  const signInSearch = { redirect: "/invitation" };
  return (
    <FallbackPage heading={differentAccount() ? "Invitation" : join()}>
      <Switch>
        <Match when={needsSignIn()}>
          <Notice role="alert">{error()}</Notice>
          <p>
            <Link
              class="stands-alone"
              to="/sign-in"
              search={signInSearch}
              hash={props.invitationId}
              ref={focusSignIn}
            >
              Sign in
            </Link>
          </p>
          <p class="prose">Forgotten its password? Whoever runs the hub can reset it.</p>
        </Match>
        <Match when={differentAccount()}>
          <p class="prose">
            This invitation is for {props.invitation.email}. You are signed in as{" "}
            {session()?.user.email}.
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
              {pending() ? "Working…" : "Sign out to use it"}
            </button>
          </form>
        </Match>
        <Match when={true}>
          <p class="prose">
            <Show when={session()}>
              {(signedIn) => <>You are signed in as {signedIn().user.email}. </>}
            </Show>
            This invitation lets {session() ? "you" : props.invitation.email} join{" "}
            {props.invitation.organizationName} as {role().startsWith("member") ? "a" : "an"}{" "}
            {role()}. It works once, until{" "}
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
                />
              </div>
            </Show>
            <Show when={error()}>{(message) => <Notice role="alert">{message()}</Notice>}</Show>
            <button type="submit" class="primary" disabled={pending()}>
              {pending() ? "Working…" : session() ? join() : "Create account and join"}
            </button>
          </form>
          <Show when={!session()}>
            <p class="prose">
              Already have an account here with this address?{" "}
              <Link to="/sign-in" search={signInSearch} hash={props.invitationId}>
                Sign in to join
              </Link>
              .
            </p>
          </Show>
        </Match>
      </Switch>
    </FallbackPage>
  );
}
