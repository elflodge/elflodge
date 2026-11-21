import { createFileRoute } from "@tanstack/solid-router";

import { NotFound } from "../../components/NotFound.tsx";
import { pageHead } from "../../page-title.ts";

// Every address no other route matches, inside the shell: a signed-in member keeps the bar and its
// destinations on a page that does not exist, and someone signed out is asked to sign in first, as
// at any other page.
export const Route = createFileRoute("/_signed-in/$")({
  head: () => pageHead("Page not found"),
  component: NotFound,
});
