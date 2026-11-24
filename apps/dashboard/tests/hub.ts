import { APIError, BASE_ERROR_CODES } from "@better-auth/core/error";
import { toKebabCase } from "@better-auth/core/utils/string";
import { ORPCError } from "@orpc/client";
import {
  ProcedureContract,
  type AnySchema,
  type ErrorMap,
  type InferSchemaInput,
  type InferSchemaOutput,
  type ORPCErrorConstructorMap,
  ValidationError,
} from "@orpc/contract";
import { implement, ProcedureImplementer, type Router } from "@orpc/server";
import { get } from "@orpc/shared";
import { getEndpoints } from "better-auth/api";
import { ORGANIZATION_ERROR_CODES } from "better-auth/client/plugins";
import { organization } from "better-auth/plugins";
import { apiContract, asError } from "contract";
import { prettifyError } from "zod/mini";

import { createApiHandler } from "../../hub/src/api-handler.ts";
import { invalidInput, type InputProblem } from "../../hub/src/invalid-input.ts";
import type { authClient } from "../src/auth-client.ts";

// A stand-in for the hub at the HTTP boundary: each endpoint answers what the test arranged, and
// records what it was sent. Its API is one router built from the contract and served through the
// hub's API handler, so the hub's routing picks the procedure and the hub's decoding, checks and
// Problem Details apply to each request and answer. It differs from the hub in one way: the hub
// serves uploads through a handler of their own that takes a file's size, and the stand-in holds an
// upload to a JSON body's limit, as no page test uploads more.

/** Better Auth's answer to a session read: who is signed in, or no one. */
export type Session = Awaited<ReturnType<typeof authClient.getSession>> | null;

/** Calls held until the test releases them. */
export interface Held<Input> {
  /** The input of the first call held. */
  readonly arrived: Promise<Input>;
  /**
   * Lets every held call go on to the answer arranged at that moment, and stops holding, so later
   * calls are answered at once.
   */
  release(): void;
}

/**
 * What a test arranges for one endpoint of the hub, and what it sees of its calls. An answer stands
 * for every call until the test arranges another, as the hub's data changes between steps.
 */
export interface Endpoint<Input, Output> {
  /**
   * Answers every call with `output`, or with what `answer` returns for the call's input. An
   * `answer` that throws fails the test.
   */
  answers(output: Output | ((input: Input) => Output | Promise<Output>)): void;
  /** Fails every call with a 500, as the hub answers when something goes wrong in it. */
  fails(): void;
  /**
   * Loses every call's answer: the hub receives the call, and the page meets a network failure, as
   * when the connection drops before the answer arrives, so it cannot tell whether the hub acted.
   */
  drops(): void;
  /** Holds every call from now until the test releases them. */
  hold(): Held<Input>;
  /** The input of every call received, in order. */
  readonly calls: readonly Input[];
}

/** One of the hub's procedures, as its contract defines it. */
export interface Procedure<Input, Output, Errors extends ErrorMap> extends Endpoint<Input, Output> {
  /**
   * Answers every call with `output`, or with what `answer` returns for the call's input. `answer`
   * may refuse a call by throwing one of the errors the contract declares for it, made with
   * `errors`. Any other error it throws fails the test, as does an answer the contract refuses.
   */
  answers(
    output:
      | Output
      | ((input: Input, errors: ORPCErrorConstructorMap<Errors>) => Output | Promise<Output>),
  ): void;
  /** Refuses every call with one of the errors the contract declares for it, as the hub writes it. */
  refuses<Code extends keyof Errors>(
    code: Code,
    ...options: Parameters<ORPCErrorConstructorMap<Errors>[Code]>
  ): void;
  /**
   * Refuses every call as invalid input, each of `problems` a message at the path of the field it is
   * about, as the hub refuses what its own checks find wrong beyond the contract's schemas.
   */
  refusesInput(problems: readonly InputProblem[]): void;
  /**
   * Answers every call with `body`, written as the hub writes an answer but not checked against the
   * contract, until the test arranges another answer: an answer from a hub of another version, or
   * a broken one.
   */
  answersUnchecked(body: unknown): void;
  /**
   * Refuses every call with a 429, as a proxy in front of the hub answers a client that sends too
   * many requests, with Problem Details that say no more than the status: a refusal the contract
   * does not declare, which asking again later can clear.
   */
  rateLimits(): void;
  /**
   * The input of every call received, in order. A request the hub's API handler refuses before the
   * procedure runs, such as one whose body is too large or whose input the contract refuses, gets
   * the hub's refusal, whatever the test arranged, and is not among them.
   */
  readonly calls: readonly Input[];
}

type Procedures<Contract> =
  Contract extends ProcedureContract<infer I, infer O, infer E>
    ? Procedure<InferSchemaOutput<I>, InferSchemaInput<O>, E>
    : { readonly [Key in keyof Contract]: Procedures<Contract[Key]> };

/** One of Better Auth's error codes, as the dashboard's client knows them. */
export type AuthErrorCode = keyof typeof authClient.$ERROR_CODES;

/** A status by the name Better Auth's routes refuse with, such as `"FORBIDDEN"`. */
export type AuthStatus = ConstructorParameters<typeof APIError>[0];

/** One of Better Auth's routes, as the dashboard's client calls it. */
export interface AuthRoute<Input, Output> extends Endpoint<Input, Output> {
  /** Refuses every call with `code` at `status`, as Better Auth's routes write a refusal. */
  refuses(status: AuthStatus, code: AuthErrorCode): void;
}

/**
 * What a call sends: its body, or for a read, its query, whose values arrive as the strings the
 * address carries.
 */
type RouteInput<Argument> = Argument extends { query?: infer Query }
  ? { query: { readonly [Key in keyof NonNullable<Query>]?: string } }
  : Omit<Argument, "fetchOptions">;

/**
 * Better Auth's routes, by the names of the client's calls, as `hub.auth.organization.removeMember`
 * for `authClient.organization.removeMember`; the session read is `hub.session`.
 */
export type AuthRoutes<Client> = {
  readonly [
    Key in keyof Client as Key extends `$${string}` | `use${string}` | "getSession" ? never : Key
  ]: Client[Key] extends (argument: infer Argument, ...rest: never[]) => Promise<infer Output>
    ? AuthRoute<RouteInput<NonNullable<Argument>>, Output>
    : AuthRoutes<Client[Key]>;
};

/** The hub as a test arranges it: every procedure of its API, by its path in the contract. */
export type Hub = Procedures<typeof apiContract> & {
  /** Better Auth's session read, which the signed-in shell makes on every navigation. */
  readonly session: Endpoint<void, Session>;
  /** Better Auth's other routes. */
  readonly auth: AuthRoutes<typeof authClient>;
};

/** The stand-in as the page's `fetch` reaches it. */
export interface HubNetwork {
  /**
   * Answers `request` as the hub would, or as the test arranged what stands between them to: a
   * `Response.error()` for an answer lost on its way back, a proxy's refusal,
   * and nothing for a request that is not one of the hub's, which fails the test as a stray.
   * `recorded` is called once a procedure or route has recorded the call, before a hold keeps it or
   * its arranged answer is given.
   */
  handle(request: Request, recorded?: () => void): Promise<Response | undefined>;
  /** The calls the test arranged no answer for, each with its input. */
  readonly unarranged: readonly string[];
  /**
   * The calls a procedure failed to answer as arranged, each with its input and the error: an
   * answer that threw, or one the contract refused.
   */
  readonly failures: readonly string[];
}

type Answer<Input, Output, Refuse, Errors> =
  | { kind: "output"; answer: (input: Input, errors: Errors) => Output | Promise<Output> }
  | { kind: "refusal"; refuse: Refuse }
  | { kind: "failure" }
  | { kind: "loss" }
  | { kind: "invalidInput"; problems: readonly InputProblem[] }
  | { kind: "unchecked"; body: unknown }
  | { kind: "rateLimit" };

/** What one endpoint was arranged to answer, and the calls it received. */
class Arrangement<Input, Output, Refuse, Errors = void> implements Endpoint<Input, Output> {
  answer: Answer<Input, Output, Refuse, Errors> | undefined;
  readonly calls: Input[] = [];
  #hold: { arrived: PromiseWithResolvers<Input>; gate: PromiseWithResolvers<void> } | undefined;

  answers(output: Output | ((input: Input, errors: Errors) => Output | Promise<Output>)) {
    this.answer = { kind: "output", answer: isAnswerFunction(output) ? output : () => output };
  }

  fails() {
    this.answer = { kind: "failure" };
  }

  drops() {
    this.answer = { kind: "loss" };
  }

  hold(): Held<Input> {
    if (this.#hold) throw new Error("Its calls are held already");
    const hold = { arrived: Promise.withResolvers<Input>(), gate: Promise.withResolvers<void>() };
    this.#hold = hold;
    return {
      arrived: hold.arrived.promise,
      release: () => {
        if (this.#hold === hold) this.#hold = undefined;
        hold.gate.resolve();
      },
    };
  }

  /**
   * Records a call, says so to `recorded`, waits while calls are held, and returns the answer that
   * stands then.
   */
  async receive(input: Input, recorded?: () => void) {
    this.calls.push(input);
    recorded?.();
    const hold = this.#hold;
    if (hold) {
      hold.arrived.resolve(input);
      await hold.gate.promise;
    }
    return this.answer;
  }
}

// What a procedure answers is JSON, never a function.
function isAnswerFunction<Input, Output, Errors>(
  value: Output | ((input: Input, errors: Errors) => Output | Promise<Output>),
): value is (input: Input, errors: Errors) => Output | Promise<Output> {
  return typeof value === "function";
}

/** What the stand-in learns of one request while the hub's handler serves it. */
interface Exchange {
  /** Called once the procedure has recorded the call. */
  recorded?: () => void;
  /**
   * What reaches the page in place of the hub's answer: a `Response.error()` for an answer lost on
   * its way back, or what something between the hub and the page answers instead.
   */
  replacement?: Response;
  /** The call a procedure took, by its name and input, once one took it. */
  call?: string;
  /** Whether what the procedure throws is the answer the test arranged. */
  arranged: boolean;
  /** How the procedure failed to answer as arranged, with its call. */
  failure?: string;
}

/** The context the stand-in's router is called with: the request's `Exchange`. */
interface StandInContext {
  exchange: Exchange;
}

/**
 * An answer that leaves the procedure past its output check: the stand-in's middleware returns its
 * `body` as the call's output, which oRPC checks only for what a procedure's handler returns.
 */
class UncheckedAnswer {
  readonly body: unknown;
  constructor(body: unknown) {
    this.body = body;
  }
}

class ContractProcedure<
  I extends AnySchema,
  O extends AnySchema,
  E extends ErrorMap,
> extends Arrangement<
  InferSchemaOutput<I>,
  InferSchemaInput<O>,
  (errors: ORPCErrorConstructorMap<E>) => Error,
  ORPCErrorConstructorMap<E>
> {
  readonly #name: string;
  readonly #unarranged: string[];

  constructor(name: string, unarranged: string[]) {
    super();
    this.#name = name;
    this.#unarranged = unarranged;
  }

  refuses<Code extends keyof E>(
    code: Code,
    ...options: Parameters<ORPCErrorConstructorMap<E>[Code]>
  ) {
    this.answer = { kind: "refusal", refuse: (errors) => errors[code](...options) };
  }

  refusesInput(problems: readonly InputProblem[]) {
    this.answer = { kind: "invalidInput", problems };
  }

  answersUnchecked(body: unknown) {
    this.answer = { kind: "unchecked", body };
  }

  rateLimits() {
    this.answer = { kind: "rateLimit" };
  }

  /** Answers a call whose input the contract accepted, as the test arranged. */
  async serve({
    input,
    errors,
    context,
  }: {
    input: InferSchemaOutput<I>;
    errors: ORPCErrorConstructorMap<E>;
    context: StandInContext;
  }): Promise<InferSchemaInput<O>> {
    if (!this.answer) {
      this.#unarranged.push(`${this.#name} with ${JSON.stringify(input)}`);
      throw new Error(`The test arranged no answer for ${this.#name}`);
    }
    const answer = await this.receive(input, context.exchange.recorded);
    context.exchange.call = `${this.#name} with ${JSON.stringify(input)}`;
    // What any other arrangement throws is its answer.
    context.exchange.arranged = answer?.kind !== "output";
    switch (answer?.kind) {
      case "output":
        try {
          return await answer.answer(input, errors);
        } catch (error) {
          // A refusal the contract declares, made with `errors`, is the answer the test arranged.
          if (error instanceof ORPCError && error.defined) context.exchange.arranged = true;
          throw error;
        }
      case "refusal":
        throw answer.refuse(errors);
      case "invalidInput":
        throw invalidInput(errors, input, answer.problems);
      case "unchecked":
        throw new UncheckedAnswer(answer.body);
      case "rateLimit":
        context.exchange.replacement = Response.json(
          { type: "about:blank", status: 429, title: "Too Many Requests" },
          { status: 429, headers: { "content-type": "application/problem+json" } },
        );
        throw new Error(`${this.#name} is refused by a proxy, as the test arranged`);
      case "loss":
        context.exchange.replacement = Response.error();
        throw new Error(`${this.#name}'s answer is lost, as the test arranged`);
      default:
        throw new Error(`${this.#name} fails, as the test arranged`);
    }
  }
}

type AnyProcedure = ContractProcedure<AnySchema, AnySchema, ErrorMap>;

/**
 * The implementer of the stand-in's procedures, each answering an `UncheckedAnswer` its handler
 * throws with its body, and recording in the call's `Exchange` an error that is not the answer the
 * test arranged. A middleware applied to the contract's implementer runs ahead of the procedures'
 * input and output checks, as the hub's access check does, so it sees an answer the contract
 * refuses; an input the contract refuses never reaches the procedure, which takes no call.
 */
const implementer = implement<typeof apiContract, StandInContext>(apiContract).use(
  async ({ next, context }, _input, output) => {
    try {
      return await next();
    } catch (error) {
      if (error instanceof UncheckedAnswer) return output({ output: error.body });
      const { exchange } = context;
      if (exchange.call !== undefined && !exchange.arranged) {
        exchange.failure = `${exchange.call}: ${describeFailure(error)}`;
      }
      throw error;
    }
  },
);

/** An error's message, and for an answer the contract refused, each problem its schema found. */
function describeFailure(caught: unknown) {
  const error = asError(caught);
  // In Zod's format, as the hub describes invalid input.
  return error.cause instanceof ValidationError
    ? `${error.message}\n${prettifyError(error.cause)}`
    : error.message;
}

/**
 * One `ContractProcedure` for each procedure of `contract`, at its path, and the router that serves
 * them.
 */
function arrange<Contract>(
  contract: Contract,
  path: string[],
  unarranged: string[],
): { hub: Procedures<Contract>; router: Router<StandInContext> };
// The contract's tree is walked at run time, which no type can follow; the overload above states
// what the walk builds.
function arrange(
  contract: unknown,
  path: string[],
  unarranged: string[],
): { hub: unknown; router: unknown } {
  if (contract instanceof ProcedureContract) {
    const procedureImplementer = get(implementer, path);
    if (!(procedureImplementer instanceof ProcedureImplementer)) {
      throw new Error(`The implementer has no procedure at ${path.join(".")}`);
    }
    const procedure: AnyProcedure = new ContractProcedure(path.join("."), unarranged);
    return {
      hub: procedure,
      router: procedureImplementer.handler((options) => procedure.serve(options)),
    };
  }
  if (typeof contract !== "object" || contract === null) {
    throw new Error(`The contract has no procedure at ${path.join(".")}`);
  }
  const children = Object.entries(contract).map(
    ([key, child]) => [key, arrange(child, [...path, key], unarranged)] as const,
  );
  return {
    hub: Object.fromEntries(children.map(([key, { hub }]) => [key, hub])),
    router: Object.fromEntries(children.map(([key, { router }]) => [key, router])),
  };
}

/** Where Better Auth's client sends its calls, on the page's own origin. */
const AUTH_BASE = "/api/auth";

/** The words and code of each refusal the client knows, as Better Auth's routes send them. */
const AUTH_ERRORS = {
  ...BASE_ERROR_CODES,
  ...ORGANIZATION_ERROR_CODES,
} satisfies Record<AuthErrorCode, { code: string; message: string }>;

/**
 * The methods each of Better Auth's routes answers, by its path under `AUTH_BASE`, as its endpoints
 * declare them: its own, and its organization plugin's, the plugin whose routes the dashboard calls.
 * Read without a hub: the endpoints wait for the context only when called.
 */
const AUTH_METHODS = new Map<string, readonly string[]>(
  Object.values(getEndpoints(new Promise<never>(() => {}), { plugins: [organization()] }).api).map(
    (endpoint) => [endpoint.path, [endpoint.options.method].flat()],
  ),
);

/** One of Better Auth's routes, by its path under `AUTH_BASE`. */
class BetterAuthRoute extends Arrangement<unknown, unknown, APIError> {
  refuses(status: AuthStatus, code: AuthErrorCode) {
    this.answer = { kind: "refusal", refuse: APIError.from(status, AUTH_ERRORS[code]) };
  }
}

const AUTH_ROUTE_MEMBERS = new Set(["answers", "refuses", "fails", "drops", "hold", "calls"]);

/**
 * The route at the client's call `path`, whose address the client builds as its proxy does, each
 * name in kebab case, kept in `routes` by that address once a test reaches it.
 */
function authRoutes(
  routes: Map<string, BetterAuthRoute>,
  path?: string[],
): AuthRoutes<typeof authClient>;
// The client's calls are names on a proxy, which no type can follow; the overload above states what
// the proxy reaches, as the client's own types do for its proxy.
function authRoutes(routes: Map<string, BetterAuthRoute>, path: string[] = []): unknown {
  return new Proxy(
    {},
    {
      get(_, key) {
        if (typeof key !== "string") return undefined;
        if (!AUTH_ROUTE_MEMBERS.has(key)) return authRoutes(routes, [...path, key]);
        const address = `/${path.map(toKebabCase).join("/")}`;
        let route = routes.get(address);
        if (!route) {
          route = new BetterAuthRoute();
          routes.set(address, route);
        }
        const member: unknown = Reflect.get(route, key);
        return typeof member === "function" ? member.bind(route) : member;
      },
    },
  );
}

/** What a call to one of Better Auth's routes sends: its query for a read, else its JSON body. */
async function authInput(request: Request) {
  const url = new URL(request.url);
  if (request.method === "GET") return { query: Object.fromEntries(url.searchParams) };
  const body = await request.text();
  return body === "" ? undefined : JSON.parse(body);
}

/** What a call to one of Better Auth's routes sends, as text: a read's query, else its body. */
async function sentInput(request: Request) {
  if (request.method === "GET") return new URL(request.url).search || "no query";
  return (await request.text()) || "no body";
}

/**
 * A stand-in for the hub that serves the dashboard at `origin`. Nothing is arranged: a call without
 * an answer fails, and is recorded in `network.unarranged`.
 */
export function createHub(origin: string): { hub: Hub; network: HubNetwork } {
  const session = new Arrangement<void, Session, never>();
  const auth = new Map<string, BetterAuthRoute>();
  const unarranged: string[] = [];
  const failures: string[] = [];
  const { hub: api, router } = arrange(apiContract, [], unarranged);
  const apiHandler = createApiHandler(router);

  const hub: Hub = { ...api, session, auth: authRoutes(auth) };

  async function serveSession(recorded?: () => void) {
    const answer = await session.receive(undefined, recorded);
    switch (answer?.kind) {
      case "output":
        return Response.json(await answer.answer());
      case "loss":
        return Response.error();
      default:
        return Response.json(null, { status: 500 });
    }
  }

  async function serveAuth(request: Request, address: string, recorded?: () => void) {
    const methods = AUTH_METHODS.get(address);
    if (!methods?.includes(request.method)) {
      unarranged.push(
        `Better Auth's ${request.method} ${address}, a route that answers ${methods?.join(" or ") ?? "no method"}`,
      );
      return Response.json(null, { status: 404 });
    }
    const route = auth.get(address);
    // Recorded as sent, before its body is decoded as JSON, which fails for a body of another type,
    // such as a form-encoded sign-in.
    if (!route?.answer) {
      unarranged.push(
        `Better Auth's ${request.method} ${address} with ${await sentInput(request)}`,
      );
      return Response.json(null, { status: 500 });
    }
    const input: unknown = await authInput(request);
    const answer = await route.receive(input, recorded);
    switch (answer?.kind) {
      case "output":
        return Response.json((await answer.answer(input)) ?? null);
      case "refusal":
        return Response.json(answer.refuse.body, { status: answer.refuse.statusCode });
      case "loss":
        return Response.error();
      default:
        return Response.json(null, { status: 500 });
    }
  }

  // Better Auth's routes first; every other request on the origin goes to the hub's API handler,
  // whose router decides whether it is a call of the API.
  async function handle(request: Request, recorded?: () => void) {
    const url = new URL(request.url);
    if (url.origin !== origin) return undefined;
    if (url.pathname === `${AUTH_BASE}/get-session` && request.method === "GET") {
      return serveSession(recorded);
    }
    if (url.pathname.startsWith(`${AUTH_BASE}/`)) {
      return serveAuth(request, url.pathname.slice(AUTH_BASE.length), recorded);
    }
    const exchange: Exchange = { arranged: false, recorded };
    const { matched, response } = await apiHandler.handle(request, { context: { exchange } });
    if (exchange.failure !== undefined) failures.push(exchange.failure);
    if (!matched) return undefined;
    return exchange.replacement ?? response;
  }

  const network: HubNetwork = {
    handle,
    unarranged,
    failures,
  };
  return { hub, network };
}
