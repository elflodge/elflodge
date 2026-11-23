import { parseFormData } from "@orpc/openapi/helpers";
import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query";
import { createFileRoute } from "@tanstack/solid-router";
import {
  AlertDialogTrigger,
  createAlertDialogController,
  type AlertDialogController,
} from "@ui-sdk/solid/alert-dialog";
import { DialogTrigger, createDialogController, type DialogController } from "@ui-sdk/solid/dialog";
import type { ApiKey } from "contract";
import { GRANTABLE_KEY_PERMISSIONS, MAX_API_KEY_NAME_LENGTH, problemOf } from "contract";
import {
  For,
  Show,
  createMemo,
  createSignal,
  deep,
  flush,
  createUniqueId,
  latest,
  onFlush,
  onSettled,
} from "solid-js";

import { api, hubFailureDetail, readFromHub, secretAnswerFailure } from "../../../api-client.ts";
import { ConfirmDialog } from "../../../components/ConfirmDialog.tsx";
import { CopyButton } from "../../../components/CopyButton.tsx";
import { FailedReadNotice, ReadErrorPage } from "../../../components/FailedReadNotice.tsx";
import { Field, FieldGroup } from "../../../components/Field.tsx";
import { FormDialog } from "../../../components/FormDialog.tsx";
import { Instant } from "../../../components/Instant.tsx";
import { Notice } from "../../../components/Notice.tsx";
import { fieldText, formRefusal } from "../../../form.ts";
import { formatCount, timeZoneNote } from "../../../format.ts";
import { memberPageHead } from "../../../page-title.ts";
import { orpc, writeAbsence } from "../../../query.ts";

export const Route = createFileRoute("/_signed-in/_member/api-keys")({
  head: ({ match }) => memberPageHead(match.context, "API keys"),
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
  const createKey = createDialogController();

  return (
    <>
      <div class="head">
        <h1>API keys</h1>
        <Show when={context().managesKeys}>
          <div class="controls">
            <DialogTrigger controller={createKey} class="primary">
              Create key
            </DialogTrigger>
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
      <Show when={context().managesKeys}>
        <CreateKey controller={createKey} />
      </Show>
    </>
  );
}

/** A key to revoke, named as the member saw it when they pressed Revoke. */
type Revocation = Pick<ApiKey, "id" | "name" | "start">;

/** A key's name and the characters it starts with, as the page names it. */
function keyLabel(key: Revocation) {
  const name = key.name || "Unnamed";
  return key.start ? `${name} ${key.start}` : name;
}

function KeyList() {
  const queryClient = useQueryClient();
  const [revoked, setRevoked] = createSignal<string>();
  const keys = useQuery(() => orpc.apiKeys.list.queryOptions());
  // While a read of the list is in flight, `keys.data` is pending, and Solid can hold the
  // confirmation's writes with a render pass here that reads it until the read lands, as its opening
  // and its "Working…" did.
  const list = createMemo(() => latest(() => deep(keys.data)));
  const revoking = useMutation(() => orpc.apiKeys.revoke.mutationOptions());
  const confirmRevoke = createAlertDialogController<Revocation>();
  let notice: HTMLElement | undefined;

  async function revoke(key: Revocation) {
    const label = keyLabel(key);
    // On its own: written beside the request, it would be held until it settles.
    onFlush(() => setRevoked(undefined));
    const queryKey = orpc.apiKeys.list.queryKey();
    const reread = () => queryClient.invalidateQueries({ queryKey, exact: true });
    try {
      await revoking.mutate({ id: key.id });
    } catch (error) {
      if (problemOf(error)?.status !== 404) {
        // Even a refused revocation can mean the key is gone since the list was read.
        void reread();
        throw error;
      }
      // One read decides whether it is already gone, while the dialog waits: tried once, within the
      // hub deadline, offline too. Not through Query: `queryClient.query` with its own retry and
      // networkMode leaves those options on the query, and an invalidation, which fetches with the
      // query's options, would then try the list once and without waiting for the network, until the
      // page's own observer reads it again.
      const current = await api.apiKeys.list().catch(() => undefined);
      if (!current) {
        void reread();
        throw error;
      }
      if (current.some((item) => item.id === key.id)) throw error;
      await writeAbsence(queryClient, queryKey, (cached) =>
        cached.filter((item) => item.id !== key.id),
      );
      setRevoked(`${label} is already gone.`);
      // On the page before the dialog closes and focus moves to it.
      flush();
      return;
    }
    setRevoked(`${label} is revoked.`);
    // Render the outcome before starting a background read that may need to retry. The read starts
    // before UI SDK closes the dialog, which is no matter: nothing the dialog, the notice or a row
    // reads waits for it.
    flush();
    void reread();
  }

  return (
    <>
      <Show when={keys.isError || list().length}>
        <p class="note">{timeZoneNote()}</p>
      </Show>
      <Show when={revoked()} keyed>
        {(message) => (
          <Notice
            role="status"
            focusRef={(element) => {
              notice = element;
            }}
          >
            {message}
          </Notice>
        )}
      </Show>
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
        when={list().length}
        fallback={
          <div class="empty">
            <h2>No API keys yet</h2>
            <p>
              A program, a script or a Runner calls the hub with a key. Create one with Create key.
            </p>
          </div>
        }
      >
        <KeyTable keys={list()} confirmRevoke={confirmRevoke} />
      </Show>
      <ConfirmDialog
        controller={confirmRevoke}
        heading={(key) => (
          <>
            Revoke <span class={key.name ? "mono" : "unnamed"}>{key.name || "Unnamed"}</span>{" "}
            <span class="sid">{key.start ?? ""}</span>?
          </>
        )}
        confirm={(key) => `Revoke ${keyLabel(key)}`}
        act={revoke}
        notice={() => notice}
      >
        {() => (
          <p>
            Calls made with it are refused from now on. Final: a revoked key cannot be restored.
          </p>
        )}
      </ConfirmDialog>
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
 * which the hub gives only in its answer and the dialog shows in place of the form, until it closes.
 */
function CreateKey(props: { controller: DialogController }) {
  const queryClient = useQueryClient();
  const shownOnceId = createUniqueId();

  // A direct call, not a mutation: the mutation cache would keep the key from its answer. It ends
  // within the hub deadline, through the API client, so the dialog that waits for it can be left.
  // The list is read again, without waiting, whatever the answer: a failure that is not a refusal
  // may come after the key was made, whose row then shows behind the dialog to check.
  async function create(element: HTMLFormElement) {
    const form = new FormData(element);
    const { permissions = {} } = parseFormData(form);
    const name = fieldText(form, "name");
    const expiresIn = EXPIRIES[Number(fieldText(form, "expiresIn"))]?.seconds;
    try {
      const { key } = await api.apiKeys.create({
        name,
        permissions,
        ...(expiresIn === undefined ? {} : { expiresIn }),
      });
      return { name, key };
    } catch (error) {
      throw secretAnswerFailure(error);
    } finally {
      void queryClient.invalidateQueries({ queryKey: orpc.apiKeys.list.key() });
    }
  }

  return (
    <FormDialog
      controller={props.controller}
      heading={() => "Create an API key"}
      confirm="Create key"
      wide
      refusal={(error) =>
        formRefusal(error, {
          name: ["name"],
          // The fieldset owns both the permission set and each indexed action in a resource.
          permissions: [
            "permissions",
            ...GRANTABLE.map(([resource]) => `permissions[${resource}][]`),
          ],
          expiresIn: ["expiresIn"],
        })
      }
      send={create}
      answer={{
        heading: (created) => (
          <>
            The new key,{" "}
            <span class={created.name ? "mono" : "unnamed"}>{created.name || "Unnamed"}</span>
          </>
        ),
        children: (created, focus) => (
          <>
            <div class="copyable">
              <pre class="code wraps command" tabindex="0" aria-label="The new API key">
                <mark class="key">{created.key}</mark>
              </pre>
              <CopyButton
                text={created.key}
                label="Copy the key"
                describedBy={shownOnceId}
                buttonRef={focus.buttonRef}
              />
            </div>
            <p class="shown-once" role="note" id={shownOnceId}>
              <b>Shown this once:</b> copy it now. The hub keeps only its hash, and this page will
              not show it again.
            </p>
          </>
        ),
      }}
    >
      {(fields) => (
        <>
          <Field
            label="Name"
            hint={`Optional, up to ${MAX_API_KEY_NAME_LENGTH} characters.`}
            error={fields.refused("name")}
          >
            {(control) => (
              <input
                {...control}
                name="name"
                autocomplete="off"
                readonly={fields.pending()}
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
            name="permissions"
            label="Permissions"
            hint="Choose at least one action."
            error={fields.refused("permissions")}
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
                        <input type="checkbox" name={`permissions[${resource}][]`} value={action} />
                        <span class="mono">{action}</span>
                      </label>
                    )}
                  </For>
                </fieldset>
              )}
            </For>
          </FieldGroup>
          <Field label="Expires" error={fields.refused("expiresIn")}>
            {(control) => (
              <select {...control} name="expiresIn">
                <For each={EXPIRIES}>
                  {(expiry, index) => <option value={String(index())}>{expiry.label}</option>}
                </For>
              </select>
            )}
          </Field>
        </>
      )}
    </FormDialog>
  );
}

function KeyTable(props: { keys: ApiKey[]; confirmRevoke: AlertDialogController<Revocation> }) {
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
                  <AlertDialogTrigger
                    controller={props.confirmRevoke}
                    payload={{ id: key().id, name: key().name, start: key().start }}
                    class="danger"
                    aria-label={`Revoke ${keyLabel(key())}`}
                  >
                    Revoke
                  </AlertDialogTrigger>
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
