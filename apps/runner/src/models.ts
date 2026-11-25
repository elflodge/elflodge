import type { CredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Effect, type Scope } from "effect";

// The Runner's Pi models: a Pi coding-agent `ModelRuntime` for each job, and one for its startup
// check and credential commands, all on the Runner's credential store.

/**
 * Makes Pi's coding-agent models on `credentials`, so a key or sign-in `login` saves, and a sign-in
 * Pi renews, reach every holder at its next model call. Kept until the scope closes, which waits
 * for the credential writes they started, such as a renewed sign-in's, so a process that ends keeps
 * the new tokens.
 */
export function acquireModelRuntime(
  credentials: CredentialStore,
): Effect.Effect<ModelRuntime, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.promise(() =>
      ModelRuntime.create({
        credentials,
        // No `models.json` from Pi's agent directory in the operator's home: the Runner is
        // configured by its environment, and a file Pi's own agent reads would change the Runner's
        // providers unseen. Without the file, Pi keeps its model catalog cache in memory too.
        modelsPath: null,
        // No model catalog from pi.dev as a runtime is made, which happens for every job: the
        // Runner's model is one of Pi's built-in ones, and a request would hold up each job's start.
        allowModelNetwork: false,
        // No availability snapshot as a runtime is made: it reads every provider's credentials, and
        // only `ModelRuntime`'s own snapshot readers use it (virtual-model routing, sign-in status),
        // which the Runner, pi-durable and the adapter do not call; they ask for auth and available
        // models directly, which reads them fresh. Pi's own `auth-check` makes its runtime so too.
        refreshOnCreate: false,
      }),
    ),
    (models) => Effect.promise(() => models.settleCredentialWrites()),
  );
}

/**
 * Has `models` call `provider`'s models at `baseUrl` with its API key alone, and keeps them there:
 * a sign-in, as one `login` saves while the Runner runs, never reaches that URL, and the extension
 * adapter refuses a job's extension that registers the provider. The startup check refuses what
 * the URL cannot serve, such as a saved sign-in or Azure.
 */
export function pinProviderToUrlWithApiKey(models: ModelRuntime, provider: string, baseUrl: URL) {
  const definition = models.getProvider(provider);
  const apiKey = definition?.auth.apiKey;
  if (!definition || !apiKey) return;
  const url = baseUrl.href;
  const atUrl = <M extends { baseUrl: string }>(model: M): M => ({ ...model, baseUrl: url });
  // A native provider rather than settings through `registerProvider`: settings would keep the
  // provider's sign-in, and the extension adapter lets a job's extension replace settings for every
  // provider but a native one.
  models.registerNativeProvider({
    ...definition,
    baseUrl: url,
    auth: { apiKey },
    getModels: () => definition.getModels().map(atUrl),
    getAllModels: definition.getAllModels && (() => definition.getAllModels?.().map(atUrl) ?? []),
  });
}

/**
 * Makes the models one job runs on, its own, so the providers its Pi extensions register reach no
 * other job, as Pi gives each session a runtime of its own; with `baseUrl`, `provider`'s models are
 * pinned there (`pinProviderToUrlWithApiKey`). Kept until the scope closes, as
 * `acquireModelRuntime` keeps them.
 */
export function acquireJobModels(
  credentials: CredentialStore,
  { provider, baseUrl }: { provider: string; baseUrl?: URL },
): Effect.Effect<ModelRuntime, never, Scope.Scope> {
  return acquireModelRuntime(credentials).pipe(
    Effect.tap((models) =>
      Effect.sync(() => {
        if (baseUrl) pinProviderToUrlWithApiKey(models, provider, baseUrl);
      }),
    ),
  );
}
