import { queryOptions } from "@tanstack/solid-query";

import { dashboardUrl } from "../../hub/src/dashboard.ts";
import { authClient } from "./auth-client.ts";
import { orpc } from "./query.ts";

export const ROLE_LABEL = { owner: "Owner", admin: "Admin", member: "Member" } as const;
const ORDERED_ROLES = ["owner", "admin", "member"] as const;
export type MemberRole = keyof typeof ROLE_LABEL;

/** Better Auth also stores combined roles, separated by commas. */
export function rolesOf(role: string) {
  const stored = role.split(",").map((word) => word.trim());
  return ORDERED_ROLES.filter((word) => stored.includes(word));
}

export function roleLabel(role: string) {
  return rolesOf(role)
    .map((word) => ROLE_LABEL[word])
    .join(", ");
}

export function asRole(role: MemberRole) {
  return role === "member" ? "a member" : `an ${role}`;
}

export function membersOptions(organizationId: string) {
  return queryOptions({
    queryKey: ["organization", organizationId, "members"],
    queryFn: ({ signal }) =>
      authClient.organization.listMembers({
        query: { organizationId, limit: 100 },
        fetchOptions: { signal },
      }),
  });
}

export type Member = Awaited<
  ReturnType<typeof authClient.organization.listMembers>
>["members"][number];

export function invitationsOptions(role: string | undefined) {
  // Owners and admins receive different lists, even in the same signed-in document.
  return orpc.invitations.list.queryOptions({
    queryKey: [...orpc.invitations.list.queryKey(), role],
  });
}

export function invitationLink(id: string) {
  const url = dashboardUrl(window.location.origin, "invitation");
  url.hash = id;
  return url;
}
