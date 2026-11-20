import { Outlet, createFileRoute, useLoaderData } from "@tanstack/solid-router";
import { Show, onSettled } from "solid-js";

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
        <>
          <div class="head">
            <h1 tabindex="-1" ref={(heading) => onSettled(() => heading.focus())}>
              Organization access
            </h1>
          </div>
          <Notice role="alert">This account is no longer a member of the Organization.</Notice>
        </>
      }
    >
      <Outlet />
    </Show>
  );
}
