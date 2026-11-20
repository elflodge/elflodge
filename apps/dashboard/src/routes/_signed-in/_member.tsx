import { Outlet, createFileRoute, useLoaderData } from "@tanstack/solid-router";
import { Show } from "solid-js";

import { FallbackPage } from "../../components/FallbackPage.tsx";
import { Notice } from "../../components/Notice.tsx";
import { canManageKeys } from "../../permissions.ts";

// The pages about the Organization. A member removed from it keeps their session, and with it their
// password, which they can still change; these pages are no longer theirs.
export const Route = createFileRoute("/_signed-in/_member")({
  beforeLoad: ({ context: { membership } }) => {
    const member = membership.status === "member" ? membership : undefined;
    return { member, managesKeys: member !== undefined && canManageKeys(member.role) };
  },
  component: Member,
});

function Member() {
  const session = useLoaderData({ from: "/_signed-in" });
  return (
    <Show
      when={session().membership.status === "member"}
      fallback={
        <FallbackPage heading="Organization access" focusHeading>
          <Notice role="alert">This account is no longer a member of the Organization.</Notice>
        </FallbackPage>
      }
    >
      <Outlet />
    </Show>
  );
}
