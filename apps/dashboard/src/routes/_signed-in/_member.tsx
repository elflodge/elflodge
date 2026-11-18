import { Outlet, createFileRoute } from "@tanstack/solid-router";
import { Show } from "solid-js";

import { Notice } from "../../components/Notice.tsx";

// The pages about the Organization. A member removed from it keeps their session, and with it their
// password, which they can still change; these pages are no longer theirs.
export const Route = createFileRoute("/_signed-in/_member")({
  component: Member,
});

function Member() {
  const context = Route.useRouteContext();
  return (
    <Show
      when={context().organization}
      fallback={
        <Notice role="alert">This account is no longer a member of the Organization.</Notice>
      }
    >
      <Outlet />
    </Show>
  );
}
