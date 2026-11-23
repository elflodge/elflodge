import { SmartCoercionHandlerPlugin } from "@orpc/json-schema";
import { BracketNotationSerializer, getOpenAPIMeta } from "@orpc/openapi";
import { OpenAPIHandler, type OpenAPIHandlerOptions } from "@orpc/openapi/fetch";
import type { Router } from "@orpc/server";
import { RequestLimitHandlerPlugin } from "@orpc/server/plugins";
import type { StandardHandlerInterceptor } from "@orpc/server/standard";
import { getOwn, isPlainObject, setOwn } from "@orpc/shared";
import { parseStandardUrl } from "@standard-server/core";
import {
  errorStatusMap,
  MAX_BODY_BYTES,
  MAX_FILE_BYTES,
  openOutputSchemaConverter,
} from "contract";
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
 * The handler the hub serves its API with, given the hub's `router` and the `plugins` of the API's
 * own, such as the one serving its OpenAPI document: how a request is routed and decoded, how much
 * body it may carry, and how a refusal or failure is written as Problem Details. The dashboard's
 * tests serve their arranged answers through it too, so a page meets the hub's own refusals of what
 * it sends.
 */
export function createApiHandler<T extends object>(
  router: Router<T>,
  plugins: NonNullable<OpenAPIHandlerOptions<T>["plugins"]> = [],
) {
  const handler = (
    maxBodySize: number,
    { filter, plugins: own = [] }: Pick<OpenAPIHandlerOptions<T>, "filter" | "plugins">,
  ) =>
    new OpenAPIHandler(router, {
      errorStatusMap,
      errorResponseBodyEncoder: toProblemDetails,
      errorResponseContentType: PROBLEM_JSON_CONTENT_TYPE,
      interceptors: [locateRequestProblems, restoreDroppedQueryNamesForValidation],
      plugins: [new RequestLimitHandlerPlugin({ maxBodySize }), coercion, ...own],
      filter,
    });
  // The same router behind two handlers, as oRPC's request limit is one per handler: an upload, whose
  // body the hub reads as it arrives, may be as large as a file, and everything else as large as a
  // JSON body. The uploads' handler routes only the upload, so a request it does not route goes to
  // the other.
  const uploads = handler(MAX_FILE_BYTES, {
    filter: (_, path) => path.join(".") === "blobs.upload",
  });
  const api = handler(MAX_BODY_BYTES, { plugins });
  return {
    async handle(...call: Parameters<typeof api.handle>) {
      const upload = await uploads.handle(...call);
      return upload.matched ? upload : await api.handle(...call);
    },
  };
}
