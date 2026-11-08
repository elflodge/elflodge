import {
  createEventBus,
  createExtensionRuntime,
  createSyntheticSourceInfo,
  ExtensionRunner,
  type EventBus,
  type ExecOptions,
  type ExecResult,
  type Extension,
  type ExtensionActions,
  type ExtensionContextActions,
  type ExtensionRuntime,
  type ModelRegistry,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";

// The part of a worker that runs extensions, built into the same bundle as the extensions so they
// share one copy of Pi's code. It loads each extension's factory against an `ExtensionAPI` of our
// own, which fills Pi's `Extension` record as Pi's loader does (the loader is not exported), and
// dispatches events through Pi's own `ExtensionRunner`, so handler order, chaining and error
// isolation are Pi's.

/** What an instance needs from its host: the conversation's state and every action that leaves the worker. */
export interface Bridge {
  readonly cwd: string;
  readonly actions: Omit<ExtensionActions, "refreshTools">;
  readonly context: ExtensionContextActions;
  /** `ctx.sessionManager`: reads of the conversation's history, answered synchronously by the host. */
  readonly sessionManager: ReadonlySessionManager;
  /** `ctx.modelRegistry`: the methods extensions use, over the host's models. */
  readonly modelRegistry: ModelRegistryFacade;
  /** `pi.exec`, run in the job's environment rather than on the host. */
  exec(command: string, args: string[], options: ExecOptions | undefined): Promise<ExecResult>;
  /** The extensions' tools or event subscriptions changed after loading. */
  changed(): void;
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
  readonly errors: readonly { readonly source: string; readonly error: string }[];
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
  const errors: { source: string; error: string }[] = [];
  for (const { source, factory } of extensions) {
    if (typeof factory !== "function") {
      errors.push({ source, error: "The module does not export a factory function" });
      continue;
    }
    const record = createRecord(source);
    const load = createExtensionApi(record, runtime, bus, bridge);
    try {
      await factory(load.api);
      load.commit();
      records.push(record);
    } catch (error) {
      load.discard();
      errors.push({ source, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const runner = new ExtensionRunner(
    records,
    runtime,
    bridge.cwd,
    asSessionManager(bridge.sessionManager),
    asModelRegistry(bridge.modelRegistry),
  );
  runner.bindCore(
    { ...bridge.actions, refreshTools: () => bridge.changed() },
    bridge.context,
    {
      registerProvider: () => unsupported("registerProvider"),
      registerNativeProvider: () => unsupported("registerProvider"),
      unregisterProvider: () => unsupported("unregisterProvider"),
      registerVirtualModel: () => unsupported("registerVirtualModel"),
      unregisterVirtualModel: () => unsupported("unregisterVirtualModel"),
    },
  );
  runner.setUIContext(undefined, "print");
  return {
    runner,
    errors,
    events: () => [...new Set(records.flatMap((record) => [...record.handlers.keys()]))],
  };
}

function unsupported(name: string): never {
  throw new Error(`${name} is not supported by pi-durable-compat yet`);
}

/**
 * Pi's runner declares Pi's own classes for these, but only stores them and hands them to
 * extensions as `ctx.sessionManager` and `ctx.modelRegistry`. A real `ModelRegistry` needs a
 * `ModelRuntime`, which loads every built-in provider (about 29 MiB per worker), and a
 * `SessionManager` keeps its own copy of the history; extensions get facades over the host instead.
 */
function asSessionManager(facade: ReadonlySessionManager): SessionManager {
  return facade as SessionManager;
}

/** See `asSessionManager`. */
function asModelRegistry(facade: ModelRegistryFacade): ModelRegistry {
  return facade as ModelRegistry;
}

type MapValue<M> = M extends Map<unknown, infer V> ? V : never;
type Handler = MapValue<Extension["handlers"]>[number];
type ToolDefinition = MapValue<Extension["tools"]>["definition"];
type Command = Omit<MapValue<Extension["commands"]>, "name" | "sourceInfo">;
type Shortcut = Omit<MapValue<Extension["shortcuts"]>, "shortcut" | "extensionPath">;
type Flag = Omit<MapValue<Extension["flags"]>, "name" | "extensionPath">;
type MessageRenderer = MapValue<Extension["messageRenderers"]>;
type EntryRenderer = MapValue<NonNullable<Extension["entryRenderers"]>>;
type ToolRenderer = NonNullable<Extension["toolRenderers"]>[number];
type ShortcutKey = Extension["shortcuts"] extends Map<infer K, unknown> ? K : never;

function createRecord(source: string): Extension {
  return {
    path: source,
    resolvedPath: source,
    sourceInfo: createSyntheticSourceInfo(source, { source: "npm" }),
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

/**
 * The `pi` an extension's factory receives, filling `record` as Pi's loader does
 * (`createExtensionAPI` in pi-coding-agent 1.5's `core/extensions/loader.js`, not exported):
 * registrations write to the record, actions go to the shared runtime the runner binds, and
 * flag values and runtime changes made while loading take effect only if the factory returns.
 * UI registrations are kept and never used, as Pi does in print mode; `exec` runs through the host.
 * Its parameters are typed by what the record stores: Pi's generic `ExtensionAPI` signatures are
 * for extension authors, and its own loader, in JavaScript, is not checked against them.
 */
function createExtensionApi(
  record: Extension,
  runtime: ExtensionRuntime,
  bus: EventBus,
  bridge: Bridge,
) {
  const pendingFlags = new Map<string, boolean | string>();
  const loadingUnsubscribers: (() => void)[] = [];
  let state: "loading" | "active" | "failed" = "loading";
  const assertActive = () => {
    if (state === "failed") {
      throw new Error(`Extension "${record.path}" failed to load and its API is no longer active.`);
    }
    runtime.assertActive();
  };
  const api = {
    on(event: string, handler: Handler) {
      assertActive();
      const registered: Handler = (...args) => handler(...args);
      const list = record.handlers.get(event) ?? [];
      list.push(registered);
      record.handlers.set(event, list);
      if (state === "active") bridge.changed();
      return () => {
        const handlers = record.handlers.get(event);
        const index = handlers?.indexOf(registered) ?? -1;
        if (!handlers || index === -1) return;
        handlers.splice(index, 1);
        if (handlers.length === 0) record.handlers.delete(event);
        bridge.changed();
      };
    },
    registerTool(tool: ToolDefinition) {
      assertActive();
      if (typeof tool.parameters !== "object" || tool.parameters === null || Array.isArray(tool.parameters)) {
        throw new Error(
          `Tool "${tool.name}" registered by extension "${record.path}" must define an object parameter schema.`,
        );
      }
      record.tools.set(tool.name, { definition: tool, sourceInfo: record.sourceInfo });
      runtime.refreshTools();
    },
    registerCommand(name: string, options: Command) {
      assertActive();
      record.commands.set(name, { name, sourceInfo: record.sourceInfo, ...options });
    },
    registerShortcut(shortcut: ShortcutKey, options: Shortcut) {
      assertActive();
      record.shortcuts.set(shortcut, { shortcut, extensionPath: record.path, ...options });
    },
    registerFlag(name: string, options: Flag) {
      assertActive();
      if (options.default !== undefined && typeof options.default !== options.type) {
        throw new Error(
          `Invalid default for flag "${name}": expected ${options.type}, got ${typeof options.default}`,
        );
      }
      record.flags.set(name, { name, extensionPath: record.path, ...options });
      if (options.default === undefined || runtime.flagValues.has(name)) return;
      if (state === "loading") {
        if (!pendingFlags.has(name)) pendingFlags.set(name, options.default);
      } else {
        runtime.flagValues.set(name, options.default);
      }
    },
    registerMessageRenderer(customType: string, renderer: MessageRenderer) {
      assertActive();
      record.messageRenderers.set(customType, renderer);
    },
    registerMarkdownTransformer(transformer: Extension["markdownTransformer"]) {
      assertActive();
      record.markdownTransformer = transformer;
    },
    registerEntryRenderer(customType: string, renderer: EntryRenderer) {
      assertActive();
      record.entryRenderers ??= new Map();
      record.entryRenderers.set(customType, renderer);
    },
    registerToolRenderer(resolver: ToolRenderer) {
      assertActive();
      record.toolRenderers ??= [];
      record.toolRenderers.push(resolver);
    },
    getFlag(name: string) {
      assertActive();
      if (!record.flags.has(name)) return undefined;
      return runtime.flagValues.has(name) ? runtime.flagValues.get(name) : pendingFlags.get(name);
    },
    sendMessage(...args: Parameters<ExtensionRuntime["sendMessage"]>) {
      assertActive();
      runtime.sendMessage(...args);
    },
    sendUserMessage(...args: Parameters<ExtensionRuntime["sendUserMessage"]>) {
      assertActive();
      runtime.sendUserMessage(...args);
    },
    appendEntry(...args: Parameters<ExtensionRuntime["appendEntry"]>) {
      assertActive();
      runtime.appendEntry(...args);
    },
    setSessionName(name: string) {
      assertActive();
      runtime.setSessionName(name);
    },
    getSessionName() {
      assertActive();
      return runtime.getSessionName();
    },
    setLabel(...args: Parameters<ExtensionRuntime["setLabel"]>) {
      assertActive();
      runtime.setLabel(...args);
    },
    exec(command: string, args: string[], options?: ExecOptions) {
      assertActive();
      return bridge.exec(command, args, options);
    },
    getActiveTools() {
      assertActive();
      return runtime.getActiveTools();
    },
    getAllTools() {
      assertActive();
      return runtime.getAllTools();
    },
    getSettings() {
      assertActive();
      return runtime.getSettings();
    },
    setActiveTools(toolNames: string[]) {
      assertActive();
      runtime.setActiveTools(toolNames);
    },
    getCommands() {
      assertActive();
      return runtime.getCommands();
    },
    setModel(...args: Parameters<ExtensionRuntime["setModel"]>) {
      assertActive();
      return runtime.setModel(...args);
    },
    getThinkingLevel() {
      assertActive();
      return runtime.getThinkingLevel();
    },
    setThinkingLevel(...args: Parameters<ExtensionRuntime["setThinkingLevel"]>) {
      assertActive();
      runtime.setThinkingLevel(...args);
    },
    registerProvider() {
      assertActive();
      unsupported("registerProvider");
    },
    unregisterProvider() {
      assertActive();
      unsupported("unregisterProvider");
    },
    registerMcpServer() {
      assertActive();
      unsupported("registerMcpServer");
    },
    unregisterMcpServer() {
      assertActive();
      unsupported("unregisterMcpServer");
    },
    getMcpServers(): [] {
      assertActive();
      return [];
    },
    registerVirtualModel() {
      assertActive();
      unsupported("registerVirtualModel");
    },
    unregisterVirtualModel() {
      assertActive();
      unsupported("unregisterVirtualModel");
    },
    events: {
      emit(channel: string, data: unknown) {
        assertActive();
        bus.emit(channel, data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        assertActive();
        const unsubscribe = runtime.trackEventBusSubscription(bus.on(channel, handler));
        if (state === "loading") loadingUnsubscribers.push(unsubscribe);
        return unsubscribe;
      },
    },
  };
  return {
    api,
    commit() {
      if (state !== "loading") return;
      for (const [name, value] of pendingFlags) {
        if (!runtime.flagValues.has(name)) runtime.flagValues.set(name, value);
      }
      state = "active";
      pendingFlags.clear();
      loadingUnsubscribers.length = 0;
    },
    discard() {
      if (state !== "loading") return;
      state = "failed";
      for (const unsubscribe of loadingUnsubscribers) unsubscribe();
      pendingFlags.clear();
      loadingUnsubscribers.length = 0;
    },
  };
}
