import {
  createEventBus,
  createExtensionRuntime,
  ExtensionRunner,
  type ExecOptions,
  type ExecResult,
  type Extension,
  type ExtensionActions,
  type ExtensionContextActions,
  type ModelRegistry,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import ensureError from "ensure-error";
import { loadExtensionFromFactory } from "pi-extension-loader";

import type { HandlerError } from "./protocol.ts";

// The part of a worker that runs extensions, built into the same bundle as the extensions so they
// share one copy of Pi's code. Pi's own loader builds each extension's `pi`, which its package does
// not export (the bundle reaches it by path, see `prepare-process.ts`), and Pi's `ExtensionRunner`
// dispatches events, so registration, handler order, chaining and error isolation are Pi's. Two
// departures: `pi.exec` runs through the host, and `pi.on` tells the host of a subscription made
// after loading, so it hooks only the events some extension listens to.

// The worker takes Pi's values from here, which shares the bundle's copy of Pi.
export { convertToLlm, DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";

/** What an instance needs from its host: the conversation's state and every action that leaves the worker. */
export interface Bridge {
  readonly cwd: string;
  readonly actions: Omit<ExtensionActions, "refreshTools">;
  readonly context: ExtensionContextActions;
  /** `ctx.sessionManager`: reads of the conversation's history, answered synchronously by the host. */
  readonly sessionManager: ReadonlySessionManager;
  /** `ctx.modelRegistry`: the methods extensions use, over the host's models. */
  readonly modelRegistry: ModelRegistryFacade;
  /** `pi.exec`, run in the host's environment for the conversation rather than in the worker. */
  exec(command: string, args: string[], options: ExecOptions | undefined): Promise<ExecResult>;
  /** The extensions' tools or event subscriptions changed after loading. */
  changed(): void;
  /** A handler failed after loading; Pi's runner catches it and goes on. */
  error(error: HandlerError): void;
}

/** What extensions read through `ctx.sessionManager`: Pi's `ReadonlySessionManager`, which its root does not export. */
export type ReadonlySessionManager = Pick<
  SessionManager,
  | "getCwd"
  | "getSessionDir"
  | "getSessionId"
  | "getSessionFile"
  | "getLeafId"
  | "getLeafEntry"
  | "getEntry"
  | "getLabel"
  | "getBranch"
  | "buildContextEntries"
  | "buildSessionProjection"
  | "getHeader"
  | "getEntries"
  | "getTree"
  | "getSessionName"
>;

/** The methods of Pi's `ModelRegistry` this package supports; the rest throw. */
export type ModelRegistryFacade = Pick<
  ModelRegistry,
  | "find"
  | "getAll"
  | "getAvailable"
  | "findOfType"
  | "hasConfiguredAuth"
  | "getApiKeyAndHeaders"
  | "getProviderAuth"
  | "getApiKeyForProvider"
  | "getError"
>;

export interface LoadedExtension {
  /** The source it came from, for reports. */
  readonly source: string;
  /** The module's default export. */
  readonly factory: unknown;
}

/** One conversation's extensions, loaded and bound. */
export interface Instance {
  readonly runner: ExtensionRunner;
  /** Extensions whose factory threw or exported no function, with the reason; the rest run. */
  readonly errors: readonly { readonly source: string; readonly message: string }[];
  /** The events some extension subscribes to now. */
  events(): string[];
}

/** Loads `extensions` for one conversation and binds them to `bridge`. */
export async function createInstance(
  extensions: readonly LoadedExtension[],
  bridge: Bridge,
): Promise<Instance> {
  const runtime = createExtensionRuntime();
  const bus = createEventBus();
  const records: Extension[] = [];
  const errors: { source: string; message: string }[] = [];
  for (const { source, factory } of extensions) {
    if (typeof factory !== "function") {
      errors.push({ source, message: "The module does not export a factory function" });
      continue;
    }
    let active = false;
    let failed = false;
    try {
      const record = await loadExtensionFromFactory(
        async (pi) => {
          pi.exec = (command, args, options) => {
            if (failed)
              throw new Error(
                `Extension "${source}" failed to load and its API is no longer active.`,
              );
            runtime.assertActive();
            return bridge.exec(command, args, options);
          };
          // A proxy keeps the overloaded signature of Pi's `on` and passes its arguments as given.
          pi.on = new Proxy(pi.on.bind(pi), {
            apply(on, receiver, args) {
              const unsubscribe: () => void = Reflect.apply(on, receiver, args);
              if (active) bridge.changed();
              let subscribed = true;
              return () => {
                if (!subscribed) return;
                subscribed = false;
                unsubscribe();
                bridge.changed();
              };
            },
          });
          await factory(pi);
        },
        bridge.cwd,
        bus,
        runtime,
        source,
      );
      active = true;
      records.push(record);
    } catch (error) {
      failed = true;
      errors.push({ source, message: ensureError(error).message });
    }
  }
  const runner = new ExtensionRunner(
    records,
    runtime,
    bridge.cwd,
    asSessionManager(bridge.sessionManager),
    asModelRegistry(bridge.modelRegistry),
  );
  // Binding flushes the providers and virtual models extensions registered while loading, which
  // fail here as unsupported; Pi reports each as an error of its extension and keeps the extension.
  const stopListening = runner.onError((error) =>
    errors.push({ source: error.extensionPath, message: error.error }),
  );
  runner.bindCore({ ...bridge.actions, refreshTools: () => bridge.changed() }, bridge.context, {
    registerProvider: () => unsupported("registerProvider"),
    registerNativeProvider: () => unsupported("registerNativeProvider"),
    unregisterProvider: () => unsupported("unregisterProvider"),
    registerVirtualModel: () => unsupported("registerVirtualModel"),
    unregisterVirtualModel: () => unsupported("unregisterVirtualModel"),
  });
  stopListening();
  runner.onError((error) =>
    bridge.error({
      source: error.extensionPath,
      event: error.event,
      message: error.error,
      ...(error.stack !== undefined && { stack: error.stack }),
    }),
  );
  runner.setUIContext(undefined, "print");
  return {
    runner,
    errors,
    events: () => [...new Set(records.flatMap((record) => [...record.handlers.keys()]))],
  };
}

function unsupported(name: string): never {
  throw new Error(`${name} is not supported by pi-durable-compat`);
}

/**
 * Pi's runner declares Pi's own classes for these, but only stores them and hands them to
 * extensions as `ctx.sessionManager` and `ctx.modelRegistry`; it would call the model registry
 * itself only for provider actions `bindCore` lacks, and `createInstance` passes all five. A real `ModelRegistry` needs a
 * `ModelRuntime`, which loads every built-in provider (about 29 MiB per worker), and a
 * `SessionManager` keeps its own copy of the history; extensions get facades over the host instead.
 */
function asSessionManager(facade: ReadonlySessionManager): SessionManager {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the runner only hands it out, as above
  return facade as SessionManager;
}

/** See `asSessionManager`. */
function asModelRegistry(facade: ModelRegistryFacade): ModelRegistry {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the runner only hands it out, as above
  return facade as ModelRegistry;
}
