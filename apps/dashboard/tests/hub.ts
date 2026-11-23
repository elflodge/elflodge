import { APIError, BASE_ERROR_CODES } from "@better-auth/core/error";
import { toKebabCase } from "@better-auth/core/utils/string";
import type {
  AnySchema,
  ErrorMap,
  InferSchemaInput,
  InferSchemaOutput,
  ORPCErrorConstructorMap,
} from "@orpc/contract";
import { ProcedureContract } from "@orpc/contract";
import { createHTTPUtils, HTTPProcedureUtils } from "@orpc/msw";
import { getDynamicPathParams, getOpenAPIMeta } from "@orpc/openapi";
import { ORGANIZATION_ERROR_CODES } from "better-auth/client/plugins";
import { apiContract } from "contract";
import { http, HttpResponse, type AnyHandler } from "msw";

import { createApiHandler } from "../../hub/src/api-handler.ts";
import type { authClient } from "../src/auth-client.ts";

// A stand-in for the hub at the HTTP boundary: each endpoint answers what the test arranged, through
// the hub's own handler configuration for its API, and records what it was sent.

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
  /** Answers every call with `output`, or with what `answer` returns for the call's input. */
  answers(output: Output | ((input: Input) => Output | Promise<Output>)): void;
  /** Fails every call with a 500, as the hub answers when something goes wrong in it. */
  fails(): void;
  /** Holds every call from now until the test releases them. */
  hold(): Held<Input>;
  /**
   * The input of every call received, in order. A call the hub refuses before its procedure runs,
   * such as one whose input the contract refuses, is not among them.
   */
  readonly calls: readonly Input[];
}

/** One of the hub's procedures, as its contract defines it. */
export interface Procedure<Input, Output, Errors extends ErrorMap> extends Endpoint<Input, Output> {
  /** Refuses every call with one of the errors the contract declares for it, as the hub writes it. */
  refuses<Code extends keyof Errors>(
    code: Code,
    ...options: Parameters<ORPCErrorConstructorMap<Errors>[Code]>
  ): void;
  /**
   * Answers every call with `body`, written as the hub writes an answer but not checked against the
   * contract: an answer from a hub of another version, or a broken one.
   */
  answersUnchecked(body: unknown): void;
}

type Procedures<Utils> =
  Utils extends HTTPProcedureUtils<object, infer I, infer O, infer E>
    ? Procedure<InferSchemaOutput<I>, InferSchemaInput<O>, E>
    : { readonly [Key in keyof Utils]: Procedures<Utils[Key]> };

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
export type Hub = Procedures<ReturnType<typeof contractUtils>> & {
  /** Better Auth's session read, which the signed-in shell makes on every navigation. */
  readonly session: Endpoint<void, Session>;
  /** Better Auth's other routes. */
  readonly auth: AuthRoutes<typeof authClient>;
  /**
   * Serves MSW's `handlers` ahead of everything else: for Better Auth's other routes, and for a
   * request outside the contract.
   */
  use(...handlers: AnyHandler[]): void;
};

/** The network serving the stand-in, which serves the handlers given in place of its own, in order. */
interface Serving {
  resetHandlers(...handlers: AnyHandler[]): void;
}

/** The stand-in as the browser's network serves it. */
export interface HubNetwork {
  /**
   * The handlers to serve, given the network, which is given them all again, in order, whenever a
   * test changes them later.
   */
  handlers(serving: Serving): AnyHandler[];
  /** The calls of procedures the test arranged no answer for, each with its input. */
  readonly unarranged: readonly string[];
  /** Lets every held call go on, so that nothing waits once the test is over. */
  releaseAll(): void;
}

function contractUtils(origin: string, disableOutputValidation: boolean) {
  return createHTTPUtils(apiContract, {
    origin,
    disableOutputValidation,
    handler: (router) => createApiHandler(router),
  });
}

type Answer<Input, Output, Refuse> =
  | { kind: "output"; answer: (input: Input) => Output | Promise<Output> }
  | { kind: "refusal"; refuse: Refuse }
  | { kind: "failure" }
  | { kind: "unchecked"; body: unknown };

/** What one endpoint was arranged to answer, and the calls it received. */
class Arrangement<Input, Output, Refuse> implements Endpoint<Input, Output> {
  answer: Answer<Input, Output, Refuse> | undefined;
  readonly calls: Input[] = [];
  #hold: { arrived: PromiseWithResolvers<Input>; gate: PromiseWithResolvers<void> } | undefined;

  answers(output: Output | ((input: Input) => Output | Promise<Output>)) {
    this.answer = { kind: "output", answer: isAnswerFunction(output) ? output : () => output };
  }

  fails() {
    this.answer = { kind: "failure" };
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

  release() {
    this.#hold?.gate.resolve();
    this.#hold = undefined;
  }

  /** Records a call, waits while calls are held, and returns the answer that stands then. */
  async receive(input: Input) {
    this.calls.push(input);
    const hold = this.#hold;
    if (hold) {
      hold.arrived.resolve(input);
      await hold.gate.promise;
    }
    return this.answer;
  }
}

// What a procedure answers is JSON, never a function.
function isAnswerFunction<Input, Output>(
  value: Output | ((input: Input) => Output | Promise<Output>),
): value is (input: Input) => Output | Promise<Output> {
  return typeof value === "function";
}

class ContractProcedure<
  I extends AnySchema,
  O extends AnySchema,
  E extends ErrorMap,
> implements Procedure<InferSchemaOutput<I>, InferSchemaInput<O>, E> {
  readonly #name: string;
  readonly #unchecked: HTTPProcedureUtils<object, I, O, E>;
  readonly #standIn: StandIn;
  /** How many parameters the procedure's path has, such as 1 for `/jobs/{id}`. */
  readonly pathParameters: number;
  readonly #arrangement = new Arrangement<
    InferSchemaOutput<I>,
    InferSchemaInput<O>,
    (errors: ORPCErrorConstructorMap<E>) => Error
  >();
  readonly #checkedHandler: AnyHandler;
  #uncheckedHandler: AnyHandler | undefined;

  constructor(
    name: string,
    checked: HTTPProcedureUtils<object, I, O, E>,
    unchecked: HTTPProcedureUtils<object, I, O, E>,
    pathParameters: number,
    standIn: StandIn,
  ) {
    this.pathParameters = pathParameters;
    this.#name = name;
    this.#unchecked = unchecked;
    this.#standIn = standIn;
    this.#checkedHandler = this.#handler(checked);
  }

  get calls(): readonly InferSchemaOutput<I>[] {
    return this.#arrangement.calls;
  }

  answers(
    output:
      | InferSchemaInput<O>
      | ((input: InferSchemaOutput<I>) => InferSchemaInput<O> | Promise<InferSchemaInput<O>>),
  ) {
    this.#arrangement.answers(output);
  }

  refuses<Code extends keyof E>(
    code: Code,
    ...options: Parameters<ORPCErrorConstructorMap<E>[Code]>
  ) {
    this.#arrangement.answer = { kind: "refusal", refuse: (errors) => errors[code](...options) };
  }

  fails() {
    this.#arrangement.fails();
  }

  answersUnchecked(body: unknown) {
    this.#arrangement.answer = { kind: "unchecked", body };
    if (this.#uncheckedHandler) return;
    this.#uncheckedHandler = this.#handler(this.#unchecked);
    // Served again in order, rather than ahead of every handler, where a parametric path's would take
    // the fixed paths beside it.
    this.#standIn.serveAgain();
  }

  hold() {
    return this.#arrangement.hold();
  }

  release() {
    this.#arrangement.release();
  }

  /** Its handlers, the one without the output check ahead once a test arranged an unchecked answer. */
  handlers() {
    return this.#uncheckedHandler
      ? [this.#uncheckedHandler, this.#checkedHandler]
      : [this.#checkedHandler];
  }

  #handler(utils: HTTPProcedureUtils<object, I, O, E>) {
    return utils.handler(async ({ input, errors }) => {
      if (!this.#arrangement.answer) {
        this.#standIn.unarranged.push(`${this.#name} with ${JSON.stringify(input)}`);
        throw new Error(`The test arranged no answer for ${this.#name}`);
      }
      const answer = await this.#arrangement.receive(input);
      switch (answer?.kind) {
        case "output":
          return answer.answer(input);
        case "refusal":
          throw answer.refuse(errors);
        case "unchecked":
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the handler without the output check serves it, so a body of any shape reaches the page
          return answer.body as InferSchemaInput<O>;
        default:
          throw new Error(`${this.#name} fails, as the test arranged`);
      }
    });
  }
}

type AnyProcedure = ContractProcedure<AnySchema, AnySchema, ErrorMap>;

/** What the stand-in's procedures share. */
interface StandIn {
  readonly procedures: AnyProcedure[];
  /** The calls of procedures the test arranged no answer for, each with its input. */
  readonly unarranged: string[];
  /** Gives the network every handler again, in order, once the page is open. */
  serveAgain(): void;
}

/** Where Better Auth's client sends its calls, on the page's own origin. */
const AUTH_BASE = "/api/auth";

/** The words and code of each refusal the client knows, as Better Auth's routes send them. */
const AUTH_ERRORS = {
  ...BASE_ERROR_CODES,
  ...ORGANIZATION_ERROR_CODES,
} satisfies Record<AuthErrorCode, { code: string; message: string }>;

/** One of Better Auth's routes, by its path under `AUTH_BASE`. */
class BetterAuthRoute extends Arrangement<unknown, unknown, APIError> {
  refuses(status: AuthStatus, code: AuthErrorCode) {
    this.answer = { kind: "refusal", refuse: APIError.from(status, AUTH_ERRORS[code]) };
  }
}

const AUTH_ROUTE_MEMBERS = new Set(["answers", "refuses", "fails", "hold", "calls"]);

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

/** One `ContractProcedure` for each procedure in `checked`, at its path, gathered in `standIn`. */
function arrange<Utils>(
  checked: Utils,
  unchecked: unknown,
  path: string[],
  standIn: StandIn,
): Procedures<Utils>;
// The contract's tree is walked at run time, which no type can follow; the overload above states
// what the walk builds, as createHTTPUtils does for its own tree.
function arrange(checked: unknown, unchecked: unknown, path: string[], standIn: StandIn): unknown {
  if (checked instanceof HTTPProcedureUtils && unchecked instanceof HTTPProcedureUtils) {
    const contract = path.reduce<unknown>(
      (node, key) => Reflect.get(Object(node), key),
      apiContract,
    );
    const route =
      contract instanceof ProcedureContract ? getOpenAPIMeta(contract)?.path : undefined;
    const procedure = new ContractProcedure(
      path.join("."),
      checked,
      unchecked,
      (route && getDynamicPathParams(route)?.length) ?? 0,
      standIn,
    );
    standIn.procedures.push(procedure);
    return procedure;
  }
  if (typeof checked !== "object" || checked === null) {
    throw new Error(`The contract has no procedure at ${path.join(".")}`);
  }
  return Object.fromEntries(
    Object.entries(checked).map(([key, child]) => [
      key,
      arrange(child, Reflect.get(Object(unchecked), key), [...path, key], standIn),
    ]),
  );
}

/**
 * A stand-in for the hub that serves the dashboard at `origin`. Nothing is arranged: a call of a
 * procedure without an answer fails, and is recorded in `network.unarranged`.
 */
export function createHub(origin: string): { hub: Hub; network: HubNetwork } {
  const session = new Arrangement<void, Session, never>();
  const auth = new Map<string, BetterAuthRoute>();
  const first: AnyHandler[] = [];
  let serving: Serving | undefined;
  const standIn: StandIn = {
    procedures: [],
    unarranged: [],
    serveAgain: () => serving?.resetHandlers(...served()),
  };

  const hub: Hub = {
    ...arrange(contractUtils(origin, false), contractUtils(origin, true), [], standIn),
    session,
    auth: authRoutes(auth),
    use(...handlers) {
      first.unshift(...handlers);
      standIn.serveAgain();
    },
  };

  const sessionHandler = http.get(`${origin}/api/auth/get-session`, async () => {
    const answer = await session.receive();
    if (answer?.kind === "output") return HttpResponse.json(await answer.answer());
    return HttpResponse.json(null, { status: 500 });
  });

  const authHandler = http.all(`${origin}${AUTH_BASE}/*`, async ({ request }) => {
    const address = new URL(request.url).pathname.slice(AUTH_BASE.length);
    const route = auth.get(address);
    const input: unknown = await authInput(request);
    if (!route?.answer) {
      standIn.unarranged.push(
        `Better Auth's ${request.method} ${address} with ${JSON.stringify(input)}`,
      );
      return HttpResponse.json(null, { status: 500 });
    }
    const answer = await route.receive(input);
    switch (answer?.kind) {
      case "output":
        return HttpResponse.json((await answer.answer(input)) ?? null);
      case "refusal":
        return HttpResponse.json(answer.refuse.body, { status: answer.refuse.statusCode });
      default:
        return HttpResponse.json(null, { status: 500 });
    }
  });

  /** Every handler of the stand-in, in the order the network serves them. */
  function served() {
    return [
      ...first,
      sessionHandler,
      authHandler,
      // Fewer path parameters first, as the hub's router prefers a fixed segment to a parameter: each
      // handler serves its procedure alone, so `/jobs/{id}`'s would also take `/jobs/counts`. The
      // router compares segments from the left; counting parameters gives its answer for the routes
      // the contract has that overlap, which differ only in a fixed last segment against a parameter.
      ...standIn.procedures
        .toSorted((a, b) => a.pathParameters - b.pathParameters)
        .flatMap((procedure) => procedure.handlers()),
    ];
  }

  const network: HubNetwork = {
    handlers(given) {
      serving = given;
      return served();
    },
    unarranged: standIn.unarranged,
    releaseAll() {
      session.release();
      for (const route of auth.values()) route.release();
      for (const procedure of standIn.procedures) procedure.release();
    },
  };
  return { hub, network };
}
