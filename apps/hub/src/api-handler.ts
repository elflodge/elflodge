import { SmartCoercionHandlerPlugin } from "@orpc/json-schema";
import { BracketNotationSerializer, getOpenAPIMeta } from "@orpc/openapi";
import { OpenAPIHandler, type OpenAPIHandlerOptions } from "@orpc/openapi/fetch";
import type { Router } from "@orpc/server";
import { RequestLimitHandlerPlugin } from "@orpc/server/plugins";
import type { StandardHandlerInterceptor } from "@orpc/server/standard";
import { getOwn, isPlainObject, setOwn } from "@orpc/shared";
import { parseStandardUrl } from "@standard-server/core";
import { errorStatusMap, MAX_BODY_BYTES, openOutputSchemaConverter } from "contract";
import { PROBLEM_JSON_CONTENT_TYPE } from "hono-problem-details";

import { locateRequestProblems, toProblemDetails } from "./problem-details.ts";

// A query string's values arrive as text; this turns them into what the input's schema expects,
// such as `after=42` into a number. Inputs convert the same with the open-output converter, so the
// contract keeps one converter.
const coercion = new SmartCoercionHandlerPlugin({ converters: [openOutputSchemaConverter] });
const bracketNotation = new BracketNotationSerializer();

// oRPC's array query style reads only bare keys, so one `status=failed` decodes as a one-element
// list. It ignores bracketed keys by design (middleapi/orpc#2500). Restore their names so strict
// validation can name each refused key.
// A one-or-list schema changes the contract's input type, the client's encoding and the CLI flag.
// Remove this if oRPC gains an option to keep or refuse bracketed names for a styled parameter.
const restoreDroppedQueryNamesForValidation: StandardHandlerInterceptor<object> = (options) => {
  const styles = getOpenAPIMeta(options.procedure)?.queryStyles;
  // oRPC's compact codec reads the query as the input object on GET and HEAD.
  if (!styles || (options.request.method !== "GET" && options.request.method !== "HEAD")) {
    return options.next();
  }
  const [, search] = parseStandardUrl(options.request.url);
  return options.next({
    ...options,
    decodeInput: async () => {
      const query = await options.decodeInput();
      if (!isPlainObject(query)) return query;
      for (const name of new URLSearchParams(search).keys()) {
        const [root = name] = bracketNotation.parsePath(name);
        if (root !== name && getOwn(styles, root) !== undefined) setOwn(query, name, undefined);
      }
      return query;
    },
  });
};

/**
 * A handler the hub serves its API with, given the hub's `router`: how a request is routed and
 * decoded, and how a refusal or failure is written as Problem Details. It carries a body up to
 * `maxBodySize`, by default a JSON body's limit, and any `plugins` of its own after the shared ones.
 * The dashboard's tests serve their arranged answers through it too, so a page meets the hub's own
 * refusals of what it sends.
 */
export function createApiHandler<T extends object>(
  router: Router<T>,
  {
    maxBodySize = MAX_BODY_BYTES,
    plugins = [],
  }: {
    maxBodySize?: number;
    plugins?: NonNullable<OpenAPIHandlerOptions<T>["plugins"]>;
  } = {},
) {
  return new OpenAPIHandler(router, {
    errorStatusMap,
    errorResponseBodyEncoder: toProblemDetails,
    errorResponseContentType: PROBLEM_JSON_CONTENT_TYPE,
    interceptors: [locateRequestProblems, restoreDroppedQueryNamesForValidation],
    plugins: [new RequestLimitHandlerPlugin({ maxBodySize }), coercion, ...plugins],
  });
}
