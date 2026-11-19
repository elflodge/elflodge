import { useQuery, useQueryClient } from "@tanstack/solid-query";
import { createFileRoute } from "@tanstack/solid-router";
import type { ApiKey } from "contract";
import { GRANTABLE_KEY_PERMISSIONS } from "contract";
import { For, Loading, Show, createSignal, onSettled } from "solid-js";

import { api, hubFailureMessage, readFromHub } from "../../../api-client.ts";
import { ConfirmAction } from "../../../components/ConfirmAction.tsx";
import { CopyButton } from "../../../components/CopyButton.tsx";
import { FailedReadNotice, ReadErrorPage } from "../../../components/FailedReadNotice.tsx";
import { Instant } from "../../../components/Instant.tsx";
import { Notice } from "../../../components/Notice.tsx";
import { createFormAction, fieldText, focusIfLost } from "../../../form.ts";
import { timeZoneNote } from "../../../format.ts";
import { orpc } from "../../../query.ts";

export const Route = createFileRoute("/_signed-in/_member/api-keys")({
  loader: async ({ context }) => {
    if (!context.managesKeys) return;
    await readFromHub("The API keys", () =>
      context.queryClient.query(orpc.apiKeys.list.queryOptions({ staleTime: "static" })),
    );
  },
  errorComponent: (props) => (
    <ReadErrorPage {...props} heading="API keys">
      <OpenApiParagraph />
    </ReadErrorPage>
  ),
  component: ApiKeys,
});

/**
 * The permissions a member may grant a key, by resource, as the hub allows them: registering
 * and listing Runners, and every job call. Only the Runner's own key, created by the hub when it
 * registers, holds `runner: actAs`.
 */
const GRANTABLE = [
  { resource: "job", legend: "Jobs", actions: GRANTABLE_KEY_PERMISSIONS.job },
  { resource: "runner", legend: "Runners", actions: GRANTABLE_KEY_PERMISSIONS.runner },
] as const;

/**
 * Submitters and Runners can run unattended until their service key is revoked. The API, CLI
 * and form default to no expiry, as Cloudflare's account API tokens do without an end date.
 * The hub leaves keyExpiration unset: @better-auth/api-key (dist/index.mjs) allows 1 to 365 days.
 * https://developers.cloudflare.com/fundamentals/api/how-to/restrict-tokens/#time-to-live-ttl-constraints
 */
const EXPIRIES = [
  { label: "Never", seconds: undefined },
  { label: "In 1 day", seconds: 86_400 },
  { label: "In 7 days", seconds: 7 * 86_400 },
  { label: "In 30 days", seconds: 30 * 86_400 },
  { label: "In 90 days", seconds: 90 * 86_400 },
  { label: "In 1 year", seconds: 365 * 86_400 },
] as const;

function OpenApiParagraph() {
  return (
    <p class="prose">
      The <a href="/spec.json">OpenAPI document</a> describes the hub's API as JSON, for an API
      client or a code generator to read.
    </p>
  );
}

function ApiKeys() {
  const context = Route.useRouteContext();
  let heading: HTMLHeadingElement | undefined;
  const [creating, setCreating] = createSignal(false);

  return (
    <Loading fallback={null}>
      <div class="head">
        <h1
          tabindex="-1"
          ref={(element) => {
            heading = element;
          }}
        >
          API keys
        </h1>
        <Show when={context().managesKeys}>
          <div class="controls">
            <button type="button" class="primary" onClick={() => setCreating(true)}>
              Create key
            </button>
          </div>
        </Show>
      </div>
      <Show
        when={context().managesKeys}
        fallback={
          <p class="prose">
            Programs, scripts and Runners call the hub with API keys. Only owners and admins see and
            manage the Organization's keys; ask one for a key you need.
          </p>
        }
      >
        <KeyList focusAfterRevoke={() => focusIfLost(heading)} />
      </Show>
      <OpenApiParagraph />
      <Show when={context().managesKeys && creating()}>
        <CreateKey onClose={() => setCreating(false)} />
      </Show>
    </Loading>
  );
}

function KeyList(props: { focusAfterRevoke: () => void }) {
  const queryClient = useQueryClient();
  const [actionFailure, setActionFailure] = createSignal<string>();
  const keys = useQuery(() => orpc.apiKeys.list.queryOptions());

  async function revoke(key: ApiKey) {
    setActionFailure(undefined);
    try {
      await api.apiKeys.revoke({ id: key.id });
      void queryClient
        .invalidateQueries({ queryKey: orpc.apiKeys.list.key() })
        .then(props.focusAfterRevoke);
      return undefined;
    } catch (error) {
      return hubFailureMessage(error);
    }
  }

  return (
    <>
      <Show when={keys.isError || keys.data.length}>
        <p class="note">{timeZoneNote()}</p>
      </Show>
      <Show when={actionFailure()}>{(message) => <Notice role="alert">{message()}</Notice>}</Show>
      {/* A read after the first that failed: what is shown is from an earlier one. */}
      <Show when={keys.isError}>
        <FailedReadNotice
          what="The API keys"
          detail={hubFailureMessage(keys.error)}
          failedAt={keys.errorUpdatedAt}
          readAt={keys.dataUpdatedAt}
        />
      </Show>
      <Show
        when={keys.data.length}
        fallback={
          <div class="empty">
            <h2>No API keys</h2>
            <p>
              A program, a script or a Runner calls the hub with a key. Create one with Create key.
            </p>
          </div>
        }
      >
        <KeyTable keys={keys.data} revoke={revoke} reportPageFailure={setActionFailure} />
      </Show>
    </>
  );
}

function validatePermissions(group: HTMLFieldSetElement) {
  group
    .querySelector("input")
    ?.setCustomValidity(group.querySelector(":checked") ? "" : "Choose at least one action.");
}

/**
 * The dialog that creates a key: its name, its permissions and when it expires, then the key itself,
 * which the hub gives only in its answer. The key is held here alone, and forgotten when the dialog
 * closes.
 */
function CreateKey(props: { onClose: () => void }) {
  const queryClient = useQueryClient();
  let dialog: HTMLDialogElement | undefined;
  const [created, setCreated] = createSignal<{ name: string; key: string }>();
  const [failure, setFailure] = createSignal<string>();
  const { pending, onSubmit } = createFormAction(create);

  async function create(element: HTMLFormElement) {
    const form = new FormData(element);
    const permissions = Object.fromEntries(
      GRANTABLE.map(
        ({ resource }) => [resource, form.getAll(resource).map(String)] as const,
      ).filter(([, actions]) => actions.length > 0),
    );
    setFailure(undefined);
    const name = fieldText(form, "name");
    const expiresIn = EXPIRIES[Number(fieldText(form, "expires"))]?.seconds;
    try {
      const { key } = await api.apiKeys.create({
        name,
        permissions,
        ...(expiresIn === undefined ? {} : { expiresIn }),
      });
      void queryClient.invalidateQueries({ queryKey: orpc.apiKeys.list.key() });
      setCreated({ name, key });
    } catch (error) {
      setFailure(hubFailureMessage(error));
    }
  }

  return (
    <dialog
      class="is-wide"
      aria-labelledby="create-key-heading"
      ref={(element) => {
        dialog = element;
        onSettled(() => element.showModal());
      }}
      onClose={props.onClose}
    >
      <Show
        when={created()}
        fallback={
          <form onSubmit={onSubmit}>
            <h2 class="dialog-h" id="create-key-heading">
              Create an API key
            </h2>
            <div class="dialog-b">
              <div class="field">
                <label for="key-name">Name</label>
                {/* Better Auth defaults maximumNameLength to 32 for API keys. */}
                <input
                  id="key-name"
                  name="name"
                  autocomplete="off"
                  maxlength={32}
                  aria-describedby="key-name-hint"
                />
                <p class="note" id="key-name-hint">
                  Optional, up to 32 characters.
                </p>
              </div>
              <fieldset
                class="field"
                aria-describedby="key-permissions-hint"
                ref={(group) => {
                  onSettled(() => validatePermissions(group));
                }}
                onChange={(event) => validatePermissions(event.currentTarget)}
              >
                <legend>Permissions</legend>
                <p class="note" id="key-permissions-hint">
                  Choose at least one action.
                </p>
                <For each={GRANTABLE}>
                  {(group) => (
                    <fieldset class="check-group">
                      <legend>{group.legend}</legend>
                      <For each={group.actions}>
                        {(action) => (
                          <label class="check">
                            <input type="checkbox" name={group.resource} value={action} />
                            <span class="mono">{action}</span>
                          </label>
                        )}
                      </For>
                    </fieldset>
                  )}
                </For>
              </fieldset>
              <div class="field">
                <label for="key-expires">Expires</label>
                <select id="key-expires" name="expires">
                  <For each={EXPIRIES}>
                    {(expiry, index) => <option value={String(index())}>{expiry.label}</option>}
                  </For>
                </select>
              </div>
              <Show when={failure()}>{(message) => <Notice role="alert">{message()}</Notice>}</Show>
            </div>
            <div class="dialog-f">
              <button type="button" onClick={() => dialog?.close()}>
                Cancel
              </button>
              <button type="submit" class="primary" disabled={pending()}>
                Create key
              </button>
            </div>
          </form>
        }
      >
        {(shown) => (
          <form method="dialog">
            <h2 class="dialog-h" id="create-key-heading">
              The new key,{" "}
              <span class={shown().name ? "mono" : "unnamed"}>{shown().name || "Unnamed"}</span>
            </h2>
            <div class="dialog-b">
              <div class="copyable">
                <pre class="code wraps command" tabindex="0" aria-label="The new API key">
                  <mark class="key">{shown().key}</mark>
                </pre>
                <CopyButton
                  text={shown().key}
                  label="Copy the key"
                  buttonRef={(button) => {
                    onSettled(() => button.focus());
                  }}
                />
              </div>
              <p class="shown-once" role="note">
                <b>Shown this once:</b> copy it now. The hub keeps only its hash, and this page will
                not show it again.
              </p>
            </div>
            <div class="dialog-f">
              <button value="done">Done</button>
            </div>
          </form>
        )}
      </Show>
    </dialog>
  );
}

function KeyTable(props: {
  reportPageFailure: (message: string) => void;
  keys: ApiKey[];
  revoke: (key: ApiKey) => Promise<string | undefined>;
}) {
  return (
    <table class="records is-narrow" role="table">
      <caption class="vh">API keys</caption>
      <thead role="rowgroup">
        <tr role="row">
          <th scope="col" role="columnheader">
            Name
          </th>
          <th scope="col" role="columnheader">
            Starts with
          </th>
          <th scope="col" role="columnheader">
            Permissions
          </th>
          <th scope="col" role="columnheader">
            Created
          </th>
          <th scope="col" role="columnheader">
            Expires
          </th>
          <th scope="col" role="columnheader">
            <span class="vh">Revoke</span>
          </th>
        </tr>
      </thead>
      <tbody role="rowgroup">
        <For each={props.keys} keyed={(key) => key.id}>
          {(key) => {
            const name = () => key().name || "Unnamed";
            const label = () => (key().start ? `${name()} ${key().start}` : name());
            return (
              <tr role="row">
                <td role="cell" class="is-id">
                  <span class={!key().name ? "cut unnamed" : "cut mono"} title={name()}>
                    {name()}
                  </span>
                </td>
                <td role="cell" data-l="Starts with">
                  <span class="mono">{key().start ?? ""}</span>
                </td>
                <td role="cell" data-l="Permissions">
                  <Permissions permissions={key().permissions} />
                </td>
                <td role="cell" data-l="Created">
                  <Instant value={key().createdAt} />
                </td>
                <td role="cell" data-l="Expires">
                  <Expiry expiresAt={key().expiresAt} />
                </td>
                <td role="cell" class="is-act">
                  <ConfirmAction
                    trigger="Revoke"
                    reportPageFailure={props.reportPageFailure}
                    triggerLabel={`Revoke ${label()}`}
                    heading={
                      <>
                        Revoke <span class={!key().name ? "unnamed" : "mono"}>{name()}</span>{" "}
                        <span class="sid">{key().start ?? ""}</span>?
                      </>
                    }
                    confirm={`Revoke ${label()}`}
                    act={() => props.revoke(key())}
                  >
                    <p>
                      Calls made with it are refused from now on. Final: a revoked key cannot be
                      restored.
                    </p>
                  </ConfirmAction>
                </td>
              </tr>
            );
          }}
        </For>
      </tbody>
    </table>
  );
}

/** A key's permissions, one resource a line, as the API names them. */
function Permissions(props: { permissions: ApiKey["permissions"] }) {
  const entries = () => Object.entries(props.permissions ?? {});
  return (
    <Show when={entries().length > 0} fallback="None">
      <ul class="plain">
        <For each={entries()}>
          {([resource, actions]) => (
            <li class="mono">
              {resource}: {actions.join(", ")}
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

/** When a key stops working, whether it already has, or that it never does. */
function Expiry(props: { expiresAt: Date | null }) {
  return (
    <Show when={props.expiresAt} fallback="Never">
      {(at) => (
        <>
          {at().getTime() <= Date.now() ? "Expired " : ""}
          <Instant value={at()} />
        </>
      )}
    </Show>
  );
}
