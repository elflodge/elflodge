import { parseFormData } from "@orpc/openapi/helpers";
import { useQueryClient, type QueryKey } from "@tanstack/solid-query";
import { deepEqual, linkOptions, trimPathRight, useRouter } from "@tanstack/solid-router";
import { onFlush } from "solid-js";
import * as z from "zod/mini";

import { createFormAction } from "./form.ts";

export const optionalText = z.catch(z.optional(z.string().check(z.minLength(1))), undefined);

/** Apply a question to the address, or read the same question again in place. */
export function createSearchForm<T extends Record<string, unknown>>(options: {
  to: "/jobs" | "/batches" | "/usage";
  schema: z.ZodMiniType<T>;
  queryKey: (search: T) => QueryKey;
  beforeSubmit?: (form: FormData) => void;
  retryFirstRead?: boolean;
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
    if (
      trimPathRight(current.pathname) !== trimPathRight(next.pathname) ||
      !deepEqual(options.schema.parse(current.search), options.schema.parse(next.search))
    ) {
      return router.navigate(destination);
    }
    // An unchanged navigation inside the Solid action can wait on its own commit.
    const queryKey = options.queryKey(search);
    if (options.retryFirstRead && client.getQueryData(queryKey) === undefined) {
      // Only the form's disabled observer remains after a loader refusal.
      // Invalidate after the pending flush. Inside this action the router waits for a
      // commit that the action itself is holding, leaving Show pending after the retry.
      return new Promise<void>((resolve) =>
        onFlush(() => resolve(router.invalidate({ filter: (match) => match.status === "error" }))),
      );
    }
    return client.invalidateQueries(
      { queryKey, exact: true },
      options.retryFirstRead ? { cancelRefetch: false } : undefined,
    );
  });
}
