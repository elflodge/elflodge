import { useQuery, useQueryClient } from "@tanstack/solid-query";
import { createFileRoute } from "@tanstack/solid-router";
import type { ApiKey } from "contract";
import { KEY_PERMISSIONS } from "contract";
import { For, Loading, Show, createSignal } from "solid-js";

import { api, hubFailureMessage, readFromHub } from "../../../api-client.ts";
import { ConfirmAction } from "../../../components/ConfirmAction.tsx";
import { CopyButton } from "../../../components/CopyButton.tsx";
import { Instant } from "../../../components/Instant.tsx";
import { Notice } from "../../../components/Notice.tsx";
import { fieldText } from "../../../form.ts";
import { TIME_ZONED, timeZoneNote } from "../../../format.ts";
import { canManageKeys } from "../../../permissions.ts";
import { orpc } from "../../../query.ts";

export const Route = createFileRoute("/_signed-in/_member/api-keys")({
  loader: async ({ context }) => {
    if (context.membership.status !== "member" || !canManageKeys(context.membership.role)) return;
    await readFromHub("The API keys", () =>
      context.queryClient.query(orpc.apiKeys.list.queryOptions({ staleTime: "static" })),
    );
  },
  component: ApiKeys,
});

/**
 * The permissions a member may grant a key, by resource, as the hub allows them: registering
 * Runners, and every job call. The hub refuses any other, such as `runner: actAs`, which only a
 * Runner's own key holds, created by the hub when the Runner registers.
 */
const GRANTABLE = [
  { resource: "job", legend: "Jobs", actions: KEY_PERMISSIONS.job },
  { resource: "runner", legend: "Runners", actions: ["register"] },
] as const;

/** How long a new key may live, as the hub allows: from a day to a year, or for good. */
const EXPIRIES = [
  { label: "Never", seconds: undefined },
  { label: "In 1 day", seconds: 86_400 },
  { label: "In 7 days", seconds: 7 * 86_400 },
  { label: "In 30 days", seconds: 30 * 86_400 },
  { label: "In 90 days", seconds: 90 * 86_400 },
  { label: "In 1 year", seconds: 365 * 86_400 },
] as const;

function ApiKeys() {
  const context = Route.useRouteContext();
  const managesKeys = () => {
    const { membership } = context();
    return membership.status === "member" && canManageKeys(membership.role);
  };
  let createKey: HTMLDialogElement | undefined;

  return (
    <Loading fallback={null}>
      <div class="head">
        <h1>API keys</h1>
        <Show when={managesKeys()}>
          <div class="controls">
            <button type="button" class="primary" onClick={() => createKey?.showModal()}>
              Create key
            </button>
          </div>
        </Show>
      </div>
      <Show
        when={managesKeys()}
        fallback={
          <p class="prose">
            Programs, scripts and Runners call the hub with API keys. Only owners and admins see and
            manage the Organization's keys; ask one for a key you need.
          </p>
        }
      >
        <KeyList />
        <CreateKey
          dialogRef={(element) => {
            createKey = element;
          }}
        />
      </Show>
    </Loading>
  );
}

function KeyList() {
  const queryClient = useQueryClient();
  const keys = useQuery(() => orpc.apiKeys.list.queryOptions());

  async function revoke(key: ApiKey) {
    try {
      await api.apiKeys.revoke({ id: key.id });
      void queryClient.invalidateQueries({ queryKey: orpc.apiKeys.list.key() });
      return undefined;
    } catch (error) {
      return hubFailureMessage(error);
    }
  }

  return (
    <>
      {/* A read after the first that failed: what is shown is from an earlier one. */}
      <Show when={keys.isError}>
        <Notice role="alert">
          The API keys could not be read at{" "}
          <Instant value={new Date(keys.errorUpdatedAt)} format={TIME_ZONED} />:{" "}
          {hubFailureMessage(keys.error)} What is shown is from the read at{" "}
          <Instant value={new Date(keys.dataUpdatedAt)} format={TIME_ZONED} />.
        </Notice>
      </Show>
      <Show when={keys.data}>
        {(list) => (
          <Show
            when={list().length > 0}
            fallback={
              <div class="empty">
                <h2>No API keys</h2>
                <p>
                  A program, a script or a Runner calls the hub with a key. Create one with Create
                  key; it is listed here until it is revoked.
                </p>
              </div>
            }
          >
            <p class="note">{timeZoneNote()}</p>
            <KeyTable keys={list()} revoke={revoke} />
          </Show>
        )}
      </Show>
    </>
  );
}

/**
 * The dialog that creates a key: its name, its permissions and when it expires, then the key itself,
 * which the hub gives only in its answer. The key is held here alone, and forgotten when the dialog
 * closes.
 */
function CreateKey(props: { dialogRef: (element: HTMLDialogElement) => void }) {
  const queryClient = useQueryClient();
  let dialog: HTMLDialogElement | undefined;
  const [created, setCreated] = createSignal<{ name: string; key: string }>();
  const [failure, setFailure] = createSignal<string>();
  const [pending, setPending] = createSignal(false);

  async function create(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const permissions = Object.fromEntries(
      GRANTABLE.map(({ resource, actions }) => [
        resource,
        actions.filter((action) => form.has(`${resource}:${action}`)),
      ]).filter(([, actions]) => actions.length > 0),
    );
    const name = fieldText(form, "name");
    const expiresIn = EXPIRIES[Number(fieldText(form, "expires"))]?.seconds;
    setPending(true);
    setFailure(undefined);
    try {
      const { key } = await api.apiKeys.create({
        name,
        permissions,
        ...(expiresIn === undefined ? {} : { expiresIn }),
      });
      setCreated({ name, key });
      void queryClient.invalidateQueries({ queryKey: orpc.apiKeys.list.key() });
    } catch (error) {
      setFailure(hubFailureMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <dialog
      class="is-wide"
      aria-labelledby="create-key-heading"
      ref={(element) => {
        dialog = element;
        props.dialogRef(element);
      }}
      onClose={() => {
        setCreated(undefined);
        setFailure(undefined);
      }}
    >
      <Show
        when={created()}
        fallback={
          <form onSubmit={create}>
            <h2 class="dialog-h" id="create-key-heading">
              Create an API key
            </h2>
            <div class="dialog-b">
              <div class="field">
                <label for="key-name">Name</label>
                <input id="key-name" name="name" autocomplete="off" required />
              </div>
              <fieldset class="field">
                <legend>Permissions</legend>
                <For each={GRANTABLE}>
                  {(group) => (
                    <fieldset class="check-group">
                      <legend>{group.legend}</legend>
                      <For each={group.actions}>
                        {(action) => (
                          <label class="check">
                            <input type="checkbox" name={`${group.resource}:${action}`} />
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
              The new key, <span class="mono">{shown().name}</span>
            </h2>
            <div class="dialog-b">
              <div class="copyable">
                <pre class="code wraps command" tabindex="0" aria-label="The new API key">
                  <mark class="key">{shown().key}</mark>
                </pre>
                <CopyButton text={shown().key} label="Copy the key" />
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

function KeyTable(props: { keys: ApiKey[]; revoke: (key: ApiKey) => Promise<string | undefined> }) {
  return (
    <table class="records" role="table">
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
            const name = () => key().name ?? "Unnamed";
            const label = () => (key().start ? `${name()} ${key().start}` : name());
            return (
              <tr role="row">
                <td role="cell" class="is-id">
                  <span class="cut mono" title={name()}>
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
                    triggerLabel={`Revoke ${label()}`}
                    heading={
                      <>
                        Revoke <span class="mono">{name()}</span>{" "}
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
