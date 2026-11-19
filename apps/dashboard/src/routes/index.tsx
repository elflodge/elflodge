import { createFileRoute, redirect } from "@tanstack/solid-router";

// The dashboard opens on the jobs list. Before the session is read: the list's own route sends
// someone signed out to sign in, and back to the list once signed in.
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/jobs", replace: true });
  },
});
