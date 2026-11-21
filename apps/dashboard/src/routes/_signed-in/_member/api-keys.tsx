import { parseFormData } from "@orpc/openapi/helpers";
import { useQuery, useQueryClient } from "@tanstack/solid-query";
import { createFileRoute } from "@tanstack/solid-router";
import type { ApiKey } from "contract";
import { GRANTABLE_KEY_PERMISSIONS, MAX_API_KEY_NAME_LENGTH, problemOf } from "contract";
import { For, Show, createSignal, flush, onSettled } from "solid-js";

import { api, hubFailureDetail, hubFailureMessage, readFromHub } from "../../../api-client.ts";
import { ConfirmAction } from "../../../components/ConfirmAction.tsx";
import { CopyButton } from "../../../components/CopyButton.tsx";
import { FailedReadNotice, ReadErrorPage } from "../../../components/FailedReadNotice.tsx";
import { Field, FieldGroup } from "../../../components/Field.tsx";
import { Instant } from "../../../components/Instant.tsx";
import { Notice } from "../../../components/Notice.tsx";
import { formRefusal, createFormAction, fieldText, focusAfterRowDrops } from "../../../form.ts";
import { formatCount, timeZoneNote } from "../../../format.ts";
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
const GRANTABLE = Object.entries({
  job: { legend: "Jobs", actions: GRANTABLE_KEY_PERMISSIONS.job },
  runner: { legend: "Runners", actions: GRANTABLE_KEY_PERMISSIONS.runner },
} satisfies {
  [R in keyof typeof GRANTABLE_KEY_PERMISSIONS]: {
    legend: string;
    actions: (typeof GRANTABLE_KEY_PERMISSIONS)[R];
  };
});

/**
 * Submitters and Runners can run unattended until their service key is revoked. The API, CLI
 * and form default to no expiry, as Cloudflare's account API tokens do without an end date.
 * GitHub offers 7, 30, 60 and 90 days for personal access tokens. Our presets reach both hub bounds.
 * We leave out 60: each preset is several times the one before, and 60 would sit between 30 and
 * 90, where either neighbour serves.
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
  const [creating, setCreating] = createSignal(false);

  return (
    <>
      <div class="head">
        <h1>API keys</h1>
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
        <KeyList />
      </Show>
      <OpenApiParagraph />
      <Show when={context().managesKeys && creating()}>
        <CreateKey onClose={() => setCreating(false)} />
      </Show>
    </>
  );
}

function KeyList() {
  const queryClient = useQueryClient();
  const [actionFailure, setActionFailure] = createSignal<string>();
  const [revoked, setRevoked] = createSignal<{ id: string; message: string }>();
  const keys = useQuery(() => orpc.apiKeys.list.queryOptions());

  async function revoke(key: ApiKey, label: string) {
    setActionFailure(undefined);
    setRevoked(undefined);
    const queryKey = orpc.apiKeys.list.queryKey();
    const reread = () => queryClient.invalidateQueries({ queryKey, exact: true });
    try {
      await api.apiKeys.revoke({ id: key.id });
    } catch (error) {
      // Even a refused revocation can mean the key is gone since the list was read.
      const refreshed = reread();
      if (problemOf(error)?.status !== 404) return hubFailureMessage(error);
      await refreshed;
      const list = queryClient.getQueryState(queryKey);
      if (!list?.data || list.isInvalidated || list.data.some((item) => item.id === key.id))
        return hubFailureMessage(error);
      setRevoked({ id: key.id, message: `${label} is already gone.` });
      return undefined;
    }
    setRevoked({ id: key.id, message: `${label} is revoked.` });
    // Render the outcome before starting a background read that may need to retry.
    flush();
    void reread();
    return undefined;
  }

  return (
    <>
      <Show when={keys.isError || keys.data.length}>
        <p class="note">{timeZoneNote()}</p>
      </Show>
      <Show when={revoked()} keyed>
        {(revocation) => (
          <Notice
            role="status"
            focusRef={(element) =>
              focusAfterRowDrops(element, () => keys.data.some((key) => key.id === revocation.id))
            }
          >
            {revocation.message}
          </Notice>
        )}
      </Show>
      <Show when={actionFailure()}>{(message) => <Notice role="alert">{message()}</Notice>}</Show>
      {/* A read after the first that failed: what is shown is from an earlier one. */}
      <Show when={keys.isError}>
        <FailedReadNotice
          what="The API keys"
          detail={hubFailureDetail(keys.error)}
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
  const [failure, setFailure] = createSignal<ReturnType<typeof formRefusal>>();
  const field = (name: string) => failure()?.fields.get(name);
  const { pending, onSubmit } = createFormAction(create);

  async function create(element: HTMLFormElement) {
    const form = new FormData(element);
    const { permissions = {} } = parseFormData(form);
    setFailure(undefined);
    const name = fieldText(form, "name");
    const expiresIn = EXPIRIES[Number(fieldText(form, "expiresIn"))]?.seconds;
    try {
      const { key } = await api.apiKeys.create({
        name,
        permissions,
        ...(expiresIn === undefined ? {} : { expiresIn }),
      });
      void queryClient.invalidateQueries({ queryKey: orpc.apiKeys.list.key() });
      setCreated({ name, key });
    } catch (error) {
      setFailure(
        formRefusal(error, {
          name: ["name"],
          // The fieldset owns both the permission set and each indexed action in a resource.
          permissions: [
            "permissions",
            ...GRANTABLE.map(([resource]) => `permissions[${resource}][]`),
          ],
          expiresIn: ["expiresIn"],
        }),
      );
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
              <Field
                label="Name"
                hint={`Optional, up to ${MAX_API_KEY_NAME_LENGTH} characters.`}
                error={field("name")}
              >
                {(control) => (
                  <input
                    {...control}
                    name="name"
                    autocomplete="off"
                    onInput={({ currentTarget }) =>
                      currentTarget.setCustomValidity(
                        currentTarget.value.length > MAX_API_KEY_NAME_LENGTH
                          ? `Use a name of ${MAX_API_KEY_NAME_LENGTH} characters or fewer. This one has ${formatCount(currentTarget.value.length)}.`
                          : "",
                      )
                    }
                  />
                )}
              </Field>
              <FieldGroup
                label="Permissions"
                hint="Choose at least one action."
                error={field("permissions")}
                ref={(group) => {
                  onSettled(() => validatePermissions(group));
                }}
                onChange={(event) => validatePermissions(event.currentTarget)}
              >
                <For each={GRANTABLE}>
                  {([resource, group]) => (
                    <fieldset class="check-group">
                      <legend>{group.legend}</legend>
                      <For each={group.actions}>
                        {(action) => (
                          <label class="check">
                            <input
                              type="checkbox"
                              name={`permissions[${resource}][]`}
                              value={action}
                            />
                            <span class="mono">{action}</span>
                          </label>
                        )}
                      </For>
                    </fieldset>
                  )}
                </For>
              </FieldGroup>
              <Field label="Expires" error={field("expiresIn")}>
                {(control) => (
                  <select {...control} name="expiresIn">
                    <For each={EXPIRIES}>
                      {(expiry, index) => <option value={String(index())}>{expiry.label}</option>}
                    </For>
                  </select>
                )}
              </Field>
              <Show when={failure()?.alert}>
                {(message) => <Notice role="alert">{message()}</Notice>}
              </Show>
            </div>
            <div class="dialog-f">
              <button type="button" onClick={() => dialog?.close()}>
                Cancel
              </button>
              <button type="submit" class="primary" aria-disabled={pending() ? "true" : undefined}>
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
  revoke: (key: ApiKey, label: string) => Promise<string | undefined>;
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
            Created by
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
                <td role="cell" data-l="Created by">
                  <Show when={key().creator} fallback="Unknown" keyed>
                    {(creator) => (
                      <>
                        {creator.name}
                        {creator.isMember ? "" : " (no longer a member)"}
                      </>
                    )}
                  </Show>
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
                    reportPageFailure={(message) =>
                      props.reportPageFailure(`Revoke ${label()}: ${message}`)
                    }
                    triggerLabel={`Revoke ${label()}`}
                    heading={
                      <>
                        Revoke <span class={!key().name ? "unnamed" : "mono"}>{name()}</span>{" "}
                        <span class="sid">{key().start ?? ""}</span>?
                      </>
                    }
                    confirm={`Revoke ${label()}`}
                    act={() => props.revoke(key(), label())}
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
