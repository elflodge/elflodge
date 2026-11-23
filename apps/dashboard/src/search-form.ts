import { parseFormData } from "@orpc/openapi/helpers";
import { useQueryClient, type QueryKey } from "@tanstack/solid-query";
import { deepEqual, linkOptions, trimPathRight, useRouter } from "@tanstack/solid-router";
import { announce } from "@ui-sdk/core";
import * as z from "zod/mini";

import { createFormAction } from "./form.ts";

export const optionalText = z.catch(z.optional(z.string().check(z.minLength(1))), undefined);

/** Apply a question to the address, or read the same question again in place. */
export function createSearchForm<T extends Record<string, unknown>>(options: {
  to: "/jobs" | "/batches" | "/usage";
  schema: z.ZodMiniType<T>;
  queryKey: (search: T) => QueryKey;
  beforeSubmit?: (form: FormData) => void;
}) {
  const router = useRouter();
  const client = useQueryClient();
  let submittedEntry: typeof router.history.location | undefined;
  const action = createFormAction((element) => {
    const form = new FormData(element);
    options.beforeSubmit?.(form);
    const search = options.schema.parse(parseFormData(form));
    const destination = linkOptions({ to: options.to, search });
    const current = router.latestLocation;
    const next = router.buildLocation(destination);
    // The current location holds URL values: one status is text and a page cursor is still present.
    if (
      trimPathRight(current.pathname) !== trimPathRight(next.pathname) ||
      !deepEqual(options.schema.parse(current.search), search)
    ) {
      const navigation = router.navigate(destination);
      // The router pushes the history entry synchronously, before its loaders finish, while no
      // navigation blocker is registered; with one, the push waits and the form resets as before.
      submittedEntry = router.history.location;
      return navigation;
    }
    // An unchanged navigation inside the Solid action can wait on its own commit.
    announce("Working…");
    return client.invalidateQueries({ queryKey: options.queryKey(search), exact: true });
  });

  function resetForNavigation(form: HTMLFormElement) {
    // The submitting form already shows its values, possibly edited again while the read ran.
    // A link or a history traversal restores the filters from the address.
    if (router.history.location !== submittedEntry) form.reset();
    submittedEntry = undefined;
  }
  return { ...action, resetForNavigation };
}
