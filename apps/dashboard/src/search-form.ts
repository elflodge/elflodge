import { parseFormData } from "@orpc/openapi/helpers";
import { useQueryClient, type QueryKey } from "@tanstack/solid-query";
import { deepEqual, linkOptions, trimPathRight, useRouter } from "@tanstack/solid-router";
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
  return createFormAction((element) => {
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
      return router.navigate(destination);
    }
    // An unchanged navigation inside the Solid action can wait on its own commit.
    return client.invalidateQueries({ queryKey: options.queryKey(search), exact: true });
  });
}
