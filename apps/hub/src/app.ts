import { catchORPCErrorCode, middlewareGen, type WithEffectContext } from "@orpc/effect";
import "@orpc/effect/extensions/effect";
import { SmartCoercionHandlerPlugin } from "@orpc/json-schema";
import { BracketNotationSerializer, getOpenAPIMeta } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferenceHandlerPlugin } from "@orpc/openapi/plugins";
import { implement, ValidationError } from "@orpc/server";
import { RequestLimitHandlerPlugin } from "@orpc/server/plugins";
import type { StandardHandlerInterceptor } from "@orpc/server/standard";
import { getOwn, isPlainObject, matchesHttpPath, setOwn } from "@orpc/shared";
import { ZodToJsonSchemaConverter } from "@orpc/zod";
import { parseStandardUrl } from "@standard-server/core";
import {
  apiContract,
  errorStatusMap,
  getAccess,
  MAX_BODY_BYTES,
  MAX_FILE_BYTES,
  NotFound,
  PROTOCOL_UNSUPPORTED,
  RUNNER_CONNECT_PATH,
  RUNNER_NOT_FOUND,
  RUNNER_PROTOCOL_VERSIONS,
  runnerHttpContract,
  selectProtocolVersion,
} from "contract";
import { type Context, Effect, Struct } from "effect";
import { type Context as HonoContext, Hono } from "hono";
import {
  PROBLEM_JSON_CONTENT_TYPE,
  problemDetails,
  problemDetailsHandler,
} from "hono-problem-details";
import { except } from "hono/combine";
import { csrf } from "hono/csrf";

import {
  Auth,
  authenticate,
  type Caller,
  callerKey,
  callerMember,
  callerOrganizationId,
  findOrganization,
  fromBetterAuth,
  type KeyMetadata,
  requireKey,
} from "./auth/auth.ts";
import { API_KEY_CONFIG, GRANTABLE_KEY_ROLE } from "./auth/options.ts";
import {
  addJobs,
  cancelBatch,
  createBatch,
  getBatch,
  controlBatch,
  listBatches,
} from "./batches.ts";
import { checkBlobs, uploadBlob } from "./blobs.ts";
import { DASHBOARD_ASSETS, DASHBOARD_BASE } from "./dashboard.ts";
import { Db } from "./db/database.ts";
import { EventId, InputFilePath, JobId, RunnerId, UploadChunkIndex } from "./db/types.ts";
import { readInputFileChunk } from "./input-files.ts";
import {
  type Control,
  controlJob,
  countJobs,
  deleteJob,
  getJob,
  type GivenLimits,
  limitProblems,
  listJobs,
  readJobEvents,
  submitterOf,
} from "./jobs.ts";
import { generateOpenAPIDocument, sessionCookieName } from "./openapi.ts";
import { RunnerConnections, type HubServices } from "./platform.ts";
import { toProblemDetails } from "./problem-details.ts";
import { findRunnerByKey, registerRunner, removeRunner } from "./runner-registration.ts";
import { hintConnectedRunners, listRunners } from "./runners.ts";
import { JobLimitSettings } from "./settings.ts";
import { createOwnerAndOrganization } from "./setup.ts";
import { readUsage } from "./usage.ts";

interface ApiContext extends WithEffectContext<HubServices> {
  headers: Headers;
}

/**
 * Checks every call against who its contract says may make it, before its input is validated, and
 * hands the handler its `caller`. A procedure that declares no access is a hub defect, and never runs.
 */
const requireDeclaredAccess = middlewareGen<ApiContext, { caller: Caller }>(function* ({
  context,
  procedure,
  path,
  next,
}) {
  const access = getAccess(procedure);
  if (!access) return yield* Effect.die(new Error(`${path.join(".")} declares no access`));
  const caller = yield* authenticate(context.headers, access);
  return yield* next({ context: { caller } });
});

/**
 * Every call the hub serves: the API and, under `runnerProtocol`, the Runner's HTTP calls. Each
 * declares its own path, so nesting them changes no route.
 */
const hubContract = { ...apiContract, runnerProtocol: runnerHttpContract };

/** The handlers' builder: each runs with the `caller` the router's access check hands it. */
const os = implement<typeof hubContract, ApiContext & { caller: Caller }>(hubContract);

/**
 * Tells the Runners a change to a job concerns to sync now: one Runner, or every live one for a job
 * any Runner may take. They learn of it at their next sync anyway; the hint only makes it sooner, so
 * a failed one is only logged.
 */
function hintRunners(hint: RunnerId | "live" | undefined) {
  if (hint === undefined) return Effect.void;
  return (
    hint === "live"
      ? hintConnectedRunners
      : RunnerConnections.use((connections) => connections.hint(hint))
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => console.error("Hinting Runners to sync failed", cause)),
    ),
  );
}

/**
 * Applies `control` to the job `jobId`, with the limits `given` for a resume, and tells the Runners
 * it concerns to sync now.
 */
function controlJobAndHint(jobId: JobId, control: Control, given?: GivenLimits) {
  return Effect.gen(function* () {
    const { job, hint } = yield* controlJob(jobId, control, given);
    yield* hintRunners(hint);
    return job;
  });
}

/**
 * `problems` with an input, raised as oRPC raises invalid input, so the answer lists them as it lists
 * the contract's own: for what the contract's schemas cannot check, such as an Output contract's
 * schema or the hub's maximums for limits.
 */
function invalidInput<E>(
  errors: { BAD_REQUEST: (options: { cause: ValidationError }) => E },
  input: unknown,
  problems: readonly { message: string; path: readonly (string | number)[] }[],
) {
  const cause = new ValidationError({
    message: "Input validation failed",
    issues: problems,
    invalidData: input,
  });
  return errors.BAD_REQUEST({ cause });
}

// The access check is the router's alone, as oRPC's docs extend a router: applied to the handlers
// too, it would run twice on every call.
const router = implement<typeof hubContract, ApiContext>(hubContract)
  .use(requireDeclaredAccess)
  .router({
    setup: {
      get: os.setup.get.effect(function* () {
        const organization = yield* Db.use((database) => database.query(findOrganization));
        return { needed: organization === undefined };
      }),
      complete: os.setup.complete.effect(function* ({ input, errors }) {
        const { organizationName, token, ...owner } = input;
        const result = yield* Db.use((database) =>
          database.query((db) =>
            createOwnerAndOrganization(db, { name: organizationName, owner }, token),
          ),
        ).pipe(Effect.mapError((error) => fromBetterAuth(error.cause)));
        if (result !== "created") {
          yield* Effect.fail(result === "linkRefused" ? errors.FORBIDDEN() : errors.CONFLICT());
        }
      }),
    },
    runners: {
      list: os.runners.list.effect(function* () {
        return yield* listRunners;
      }),
      delete: os.runners.delete.effect(function* ({ input, context }) {
        // The ID enters the hub here.
        const runnerId = RunnerId(input.id);
        const member = yield* callerMember(context.caller);
        // Its steps run to the end once begun, also when the caller goes away and the Node hub
        // interrupts the request, so a removal leaves no Runner gone with its jobs still running.
        return yield* Effect.uninterruptible(
          removeRunner(context.headers, member.role, runnerId).pipe(
            Effect.tap(() => RunnerConnections.use((connections) => connections.drop(runnerId))),
          ),
        );
      }),
    },
    apiKeys: {
      create: os.apiKeys.create.effect(function* ({ input, context, errors }) {
        const member = yield* callerMember(context.caller);
        const grant = GRANTABLE_KEY_ROLE.authorize(input.permissions);
        if (!grant.success) return yield* Effect.fail(errors.BAD_REQUEST({ message: grant.error }));
        const auth = yield* Auth;
        // Without request headers, as a call from the hub itself: Better Auth sets a key's permissions
        // only then, and still checks that the member may create the Organization's keys.
        const key = yield* auth.call((betterAuth) =>
          betterAuth.api.createApiKey({
            body: {
              configId: API_KEY_CONFIG,
              organizationId: member.organization.id,
              userId: member.id,
              name: input.name,
              permissions: input.permissions,
              expiresIn: input.expiresIn,
              metadata: { createdBy: member.id } satisfies KeyMetadata,
            },
          }),
        );
        return { id: key.id, key: key.key };
      }),
      list: os.apiKeys.list.effect(function* ({ context }) {
        const { organization } = yield* callerMember(context.caller);
        const auth = yield* Auth;
        const { apiKeys } = yield* auth.call((betterAuth) =>
          betterAuth.api.listApiKeys({
            headers: context.headers,
            query: { organizationId: organization.id, configId: API_KEY_CONFIG },
          }),
        );
        return apiKeys;
      }),
      revoke: os.apiKeys.revoke.effect(function* ({ input, context }) {
        const auth = yield* Auth;
        yield* auth.call((betterAuth) =>
          betterAuth.api.deleteApiKey({
            headers: context.headers,
            body: { keyId: input.id, configId: API_KEY_CONFIG },
          }),
        );
      }),
    },
    blobs: {
      check: os.blobs.check.effect(function* ({ input, context, errors }) {
        const organizationId = yield* callerOrganizationId(context.caller);
        const files = yield* checkBlobs(organizationId, input.files).pipe(
          Effect.catchTag("InvalidInput", ({ problems }) =>
            Effect.fail(invalidInput(errors, input, problems)),
          ),
        );
        return { files };
      }),
      upload: os.blobs.upload.effect(function* ({ input, context, errors }) {
        const { params, headers, body } = input;
        // The `octet-stream` hint has oRPC hand over the body as a stream, whatever sent it; the
        // `Blob` branch only narrows the type the contract shares with clients.
        const stream = body instanceof Blob ? body.stream() : body;
        const organizationId = yield* callerOrganizationId(context.caller);
        return yield* uploadBlob(
          organizationId,
          params.digest,
          headers["content-length"],
          stream,
        ).pipe(
          Effect.catchTag("InvalidInput", ({ problems }) =>
            Effect.fail(invalidInput(errors, { params, headers }, problems)),
          ),
        );
      }),
    },
    batches: {
      create: os.batches.create.effect(function* ({ input, context, errors }) {
        const organizationId = yield* callerOrganizationId(context.caller);
        const submitter = yield* submitterOf(context.caller);
        return yield* createBatch(input, organizationId, submitter, yield* JobLimitSettings).pipe(
          Effect.catchTag("InvalidInput", ({ problems }) =>
            Effect.fail(invalidInput(errors, input, problems)),
          ),
        );
      }),
      addJobs: os.batches.addJobs.effect(function* ({ input, context, errors }) {
        const submitter = yield* submitterOf(context.caller);
        const added = yield* addJobs(input.id, input.jobs, submitter).pipe(
          Effect.catchTag("InvalidInput", ({ problems }) =>
            Effect.fail(invalidInput(errors, input, problems)),
          ),
        );
        if (added.jobs.some(({ created }) => created)) yield* hintRunners("live");
        return added;
      }),
      list: os.batches.list.effect(function* ({ input, errors }) {
        return yield* listBatches({
          statuses: input.status ?? [],
          labels: input.labels,
          after: input.after,
          limit: input.limit,
        }).pipe(
          Effect.catchTag("InvalidInput", ({ problems }) =>
            Effect.fail(invalidInput(errors, input, problems)),
          ),
        );
      }),
      get: os.batches.get.effect(function* ({ input }) {
        return yield* getBatch(input.id);
      }),
      pause: os.batches.pause.effect(function* ({ input }) {
        return (yield* controlBatch(input.id, "pause")).batch;
      }),
      resume: os.batches.resume.effect(function* ({ input }) {
        const { batch, hints } = yield* controlBatch(input.id, "resume");
        yield* Effect.forEach(hints, hintRunners, { discard: true });
        return batch;
      }),
      cancel: os.batches.cancel.effect(function* ({ input }) {
        const { batch, hints } = yield* cancelBatch(input.id);
        yield* Effect.forEach(hints, hintRunners, { discard: true });
        return batch;
      }),
    },
    jobs: {
      list: os.jobs.list.effect(function* ({ input }) {
        // The IDs enter the hub here.
        return yield* listJobs({
          statuses: input.status ?? [],
          labels: input.labels,
          batchId: input.batchId,
          customId: input.customId,
          runnerId: input.runnerId === undefined ? undefined : RunnerId(input.runnerId),
          statusUnknown: input.statusUnknown,
          after: input.after === undefined ? undefined : JobId(input.after),
          limit: input.limit,
        });
      }),
      counts: os.jobs.counts.effect(function* () {
        return yield* countJobs();
      }),
      get: os.jobs.get.effect(function* ({ input }) {
        // The ID enters the hub here.
        return yield* getJob(JobId(input.id));
      }),
      pause: os.jobs.pause.effect(function* ({ input }) {
        // The ID enters the hub here.
        return yield* controlJobAndHint(JobId(input.id), "pause");
      }),
      resume: os.jobs.resume.effect(function* ({ input, errors }) {
        const given = Struct.pick(input, ["runTimeoutSeconds", "modelBudgetUsd"]);
        const problems = limitProblems(given, yield* JobLimitSettings);
        if (problems.length > 0) return yield* Effect.fail(invalidInput(errors, input, problems));
        // The ID enters the hub here.
        return yield* controlJobAndHint(JobId(input.id), "resume", given);
      }),
      cancel: os.jobs.cancel.effect(function* ({ input }) {
        // The ID enters the hub here.
        return yield* controlJobAndHint(JobId(input.id), "cancel");
      }),
      delete: os.jobs.delete.effect(function* ({ input }) {
        // The ID enters the hub here.
        const { job, hint } = yield* deleteJob(JobId(input.id));
        yield* hintRunners(hint);
        return job;
      }),
      events: os.jobs.events.effect(function* ({ input }) {
        // The IDs enter the hub here.
        return yield* readJobEvents(JobId(input.id), EventId(input.after), input.limit);
      }),
    },
    usage: {
      get: os.usage.get.effect(function* ({ input, context, errors }) {
        const { status, runnerId, ...rest } = input;
        // The IDs enter the hub here; a submitter's ID stays text, as its column holds a key's or
        // a user's.
        const query = {
          ...rest,
          statuses: status ?? [],
          runnerId: runnerId === undefined ? undefined : RunnerId(runnerId),
        };
        const member = yield* callerMember(context.caller);
        return yield* readUsage(member.role, query).pipe(
          Effect.catchTag("InvalidInput", ({ problems }) =>
            Effect.fail(invalidInput(errors, input, problems)),
          ),
        );
      }),
    },
    runnerProtocol: {
      register: os.runnerProtocol.register.effect(function* ({ input, context }) {
        const key = yield* callerKey(context.caller);
        return yield* registerRunner(key.referenceId, input.name);
      }),
      getInputFileChunk: os.runnerProtocol.getInputFileChunk.effect(function* ({ input, context }) {
        const key = yield* callerKey(context.caller);
        const runnerId = yield* findRunnerByKey(key.id);
        // The IDs and the path enter the hub here.
        const chunk =
          runnerId &&
          (yield* readInputFileChunk(
            runnerId,
            JobId(input.id),
            InputFilePath(input.path),
            UploadChunkIndex(input.index),
          ));
        if (!chunk) return yield* Effect.fail(new NotFound());
        return new File([chunk], `${input.index}.zst`, { type: "application/zstd" });
      }),
    },
  });

// A query string's values arrive as text; this turns them into what the input's schema expects,
// such as `after=42` into a number.
const coercion = new SmartCoercionHandlerPlugin({ converters: [new ZodToJsonSchemaConverter()] });
const bracketNotation = new BracketNotationSerializer();

// oRPC's array query style reads only bare keys, so one `status=failed` decodes as a one-element
// list. It ignores bracketed keys by design (middleapi/orpc#2500). Restore their names so strict
// validation can name each refused key.
// A one-or-list schema changes the contract's input type, the client's encoding and the CLI flag.
// Remove this if oRPC gains an option to keep or refuse bracketed names for a styled parameter.
const restoreDroppedQueryNamesForValidation: StandardHandlerInterceptor<ApiContext> = (options) => {
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

// The same router behind two handlers, as oRPC's request limit is one per handler: uploads, whose
// body the hub reads as it arrives, may be as large as a file, and everything else as large as a
// JSON body.
const uploads = new OpenAPIHandler(router, {
  errorStatusMap,
  errorResponseBodyEncoder: toProblemDetails,
  errorResponseContentType: PROBLEM_JSON_CONTENT_TYPE,
  plugins: [new RequestLimitHandlerPlugin({ maxBodySize: MAX_FILE_BYTES }), coercion],
});

const OPENAPI_SPEC_PATH = "/spec.json";

const api = new OpenAPIHandler(router, {
  errorStatusMap,
  errorResponseBodyEncoder: toProblemDetails,
  errorResponseContentType: PROBLEM_JSON_CONTENT_TYPE,
  interceptors: [restoreDroppedQueryNamesForValidation],
  plugins: [
    new RequestLimitHandlerPlugin({ maxBodySize: MAX_BODY_BYTES }),
    coercion,
    new OpenAPIReferenceHandlerPlugin({
      specPath: OPENAPI_SPEC_PATH,
      // oRPC has no spec-only mode. Without this guard, moving the dashboard redirect would
      // expose the plugin's default reference page at `/`, which loads Scalar from a CDN.
      allow: ({ request }) => matchesHttpPath(request.url, OPENAPI_SPEC_PATH),
      // The document names the session cookie of the deployment that serves the request.
      spec: ({ context }) =>
        Effect.runPromiseWith(context["effect/context"])(sessionCookieName).then(
          generateOpenAPIDocument,
        ),
    }),
  ],
});

/**
 * The challenge every 401 carries, as HTTP requires (RFC 9110, section 15.5.2): callers authenticate
 * with an API key in `x-api-key`, or members with Better Auth's session cookie, for which HTTP has no
 * scheme.
 */
export const AUTH_CHALLENGE = 'ApiKey realm="elflodge"';

/** What the app needs from the platform it runs on. */
export interface HubPlatform<Bindings> {
  /** Runs `effect` with the platform's services, for a request made with `env`. */
  run<A, E>(env: Bindings, effect: Effect.Effect<A, E, HubServices>): Promise<A>;
  /**
   * Accepts the WebSocket that `request` opens for the Runner `runnerId`, already authenticated, on
   * platforms where upgrade requests reach the app.
   */
  acceptRunner(env: Bindings, request: Request, runnerId: RunnerId): Promise<Response>;
  /** The hub's public URL, its `HUB_URL` setting. */
  hubUrl(env: Bindings): string;
  /**
   * Serves the dashboard on Node. Workers Static Assets handle dashboard files and navigations.
   * A page's request for a missing asset reaches the Worker.
   */
  dashboard?: Hono;
}

/**
 * A refusal of a Runner's connection: Problem Details (ADR 0023) with a `code` the Runner acts on,
 * and whatever else it needs, such as the versions the hub supports.
 */
function refuseRunner(
  status: number,
  detail: string,
  extensions: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  const response = problemDetails({ status, detail, extensions }).getResponse();
  return new Response(response.body, {
    status,
    headers: { ...headers, ...Object.fromEntries(response.headers) },
  });
}

/** The hub's answer to a Runner whose key it does not know, on which the Runner stops. */
function runnerNotFound(): Response {
  return refuseRunner(
    401,
    "The hub does not know this Runner's key",
    { code: RUNNER_NOT_FOUND },
    { "www-authenticate": AUTH_CHALLENGE },
  );
}

/** The hub's answer to a Runner offering no protocol version the hub supports (ADR 0026). */
function protocolUnsupported(): Response {
  return refuseRunner(
    400,
    `The hub supports none of the protocol versions offered; it supports ${RUNNER_PROTOCOL_VERSIONS.join(", ")}`,
    { code: PROTOCOL_UNSUPPORTED, supported: RUNNER_PROTOCOL_VERSIONS },
  );
}

/**
 * Decides a request to open a Runner's WebSocket: the Runner it comes from, or the response refusing
 * it. Both hubs accept the socket their own way: on Workers the route hands it to the Runner's
 * Durable Object, and in Docker the server's upgrade hook takes it.
 */
export function decideRunnerUpgrade(request: Request) {
  // Only a WebSocket opens here; HTTP's answer to anything else names the protocol to upgrade to.
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return Effect.succeed(new Response(null, { status: 426, headers: { upgrade: "websocket" } }));
  }
  // The version first, before any database is reached or a Durable Object wakes.
  if (selectProtocolVersion(request.headers.get("sec-websocket-protocol")) === undefined) {
    return Effect.succeed(protocolUnsupported());
  }
  return authenticateRunner(request.headers);
}

/** The Runner whose own key `headers` carry, or the hub's answer refusing it. */
function authenticateRunner(headers: Headers) {
  return Effect.gen(function* () {
    const key = yield* requireKey(headers, { runner: ["actAs"] });
    return (yield* findRunnerByKey(key.id)) ?? runnerNotFound();
  }).pipe(
    // A key the hub could check and does not know; a hub that cannot reach its database tells the
    // Runner to retry.
    catchORPCErrorCode("UNAUTHORIZED", () => Effect.succeed(runnerNotFound())),
    Effect.catchTag("UnknownError", () => Effect.succeed(new Response(null, { status: 503 }))),
  );
}

/**
 * The hub's HTTP API, Better Auth's routes, the Runners' WebSocket endpoint and the dashboard, on any
 * platform.
 */
export function createApp<Bindings extends object>(platform: HubPlatform<Bindings>) {
  const app = new Hono<{ Bindings: Bindings }>();

  app.use(async (c, next) => {
    await next();
    if (c.res.status === 401 && !c.res.headers.has("www-authenticate")) {
      c.res.headers.set("www-authenticate", AUTH_CHALLENGE);
    }
  });

  // A member's requests carry their session cookie, which a browser also sends with a request another
  // site makes it send. Hono's CSRF check refuses an unsafe request that a page on another site can
  // send without asking, a form's or one with no content type, unless the browser says it comes from
  // the hub's own origin, by `Sec-Fetch-Site` or `Origin`. A JSON request from another site needs a
  // CORS preflight, which the hub never answers, so the check lets JSON through: a permissive CORS
  // policy would open the hub to it. A request carrying an API key is not checked: no browser sends
  // a key by itself, and callers with one, such as Runners, send no `Origin` and often no body. Nor
  // is one without cookies, which cannot act as a member, so that it gets the hub's own answer, such
  // as a 401 that says how to authenticate; signing in, which needs no cookie, has Better Auth's own
  // check of where it comes from.
  app.use(
    except(
      (c) => c.req.header("x-api-key") !== undefined || c.req.header("cookie") === undefined,
      csrf({ origin: (origin, c) => origin === new URL(platform.hubUrl(c.env)).origin }),
    ),
  );

  // For health checks, at the path Kubernetes' probe examples use. The hub answers once it serves
  // requests, which in Docker is after migrating and setting up (ADR 0015), and checks nothing else,
  // so an unreachable database does not count against the hub itself.
  app.get("/healthz", (c) => c.text("OK"));

  // People reach the hub through the dashboard, an app shell served under its base path (ADR 0043).
  app.get("/", (c) => c.redirect(DASHBOARD_BASE));
  if (platform.dashboard) {
    app.route(DASHBOARD_BASE.slice(0, -1), platform.dashboard);
  } else {
    // Static Assets applies _headers to the shell it serves for a navigation to this same URL.
    app.get(`${DASHBOARD_BASE}${DASHBOARD_ASSETS}/*`, async (c) => {
      const response = await c.notFound();
      response.headers.append("Vary", "Sec-Fetch-Mode");
      return response;
    });
  }

  // Better Auth's own routes, such as signing in and out, at its default path.
  app.on(["GET", "POST"], "/api/auth/*", (c) =>
    platform.run(
      c.env,
      Auth.use((auth) => auth.call((betterAuth) => betterAuth.handler(c.req.raw))),
    ),
  );

  // Paths outside the API, and failures outside oRPC, answer as the API does.
  app.notFound(() => problemDetails({ status: 404 }).getResponse());
  app.onError(problemDetailsHandler({ onUnhandledError: (error) => console.error(error) }));

  app.get(RUNNER_CONNECT_PATH, async (c) => {
    const runner = await platform.run(c.env, decideRunnerUpgrade(c.req.raw));
    if (runner instanceof Response) return runner;
    return await platform.acceptRunner(c.env, c.req.raw, runner);
  });

  /** Serves the request `c` holds with the oRPC handler `handler`. */
  const serve = async (c: HonoContext<{ Bindings: Bindings }>, handler: typeof api) => {
    const { matched, response } = await platform.run(
      c.env,
      Effect.contextWith((services: Context.Context<HubServices>) =>
        Effect.promise(() =>
          handler.handle(c.req.raw, {
            context: { "effect/context": services, headers: c.req.raw.headers },
          }),
        ),
      ),
    );
    if (!matched) return c.notFound();
    return response;
  };

  // Both spellings oRPC matches, so a trailing `/` keeps the upload's limit.
  app.on("PUT", ["/blobs/:digest", "/blobs/:digest/"], (c) => serve(c, uploads));
  app.all("*", (c) => serve(c, api));

  return app;
}
