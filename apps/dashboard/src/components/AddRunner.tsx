import { useQueryClient } from "@tanstack/solid-query";
import { Button } from "@ui-sdk/solid/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@ui-sdk/solid/dialog";
import type { Runner } from "contract";
import { Show, createEffect, createMemo, createSignal, createUniqueId, untrack } from "solid-js";

import { version } from "../../package.json";
import { api, hubWriteFailureMessage, secretAnswerFailure } from "../api-client.ts";
import { isLoopback } from "../hub-address.ts";
import { orpc } from "../query.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Notice } from "./Notice.tsx";

/**
 * The Runner image of the dashboard's own release, which is the hub's: a release sets the version in
 * every package with the image tags, and a Runner newer than its hub is not supported
 * (docs/deploy.md).
 */
const IMAGE = `ghcr.io/elflodge/elflodge-runner:${version}`;

/**
 * A registration key for another machine lasts one day, the shortest time the hub allows.
 * GitHub's self-hosted runners use a registration token that expires after one hour.
 * https://docs.github.com/en/rest/actions/self-hosted-runners#create-a-registration-token-for-a-repository
 */
const REGISTRATION_KEY_LIFE_SECONDS = 24 * 60 * 60;

const HUB_PLACEHOLDER = "<the hub's URL from that machine>";

/** A piece of a command: words typed as they are, a secret, or what the reader puts in its place. */
type Piece = { text: string; mark?: "key" | "placeholder" };

/**
 * Keep this command in step with "Start a Runner on another machine" in docs/deploy.md.
 * Both printf calls write the credentials literally to the private file that docker run reads
 * through --env-file when it creates the container.
 */
function dockerCommand(key: string | undefined, hub: Piece): Piece[] {
  return [
    {
      text: `(
  set -e
  : "\${MY_KEY:?Set MY_KEY to your OpenRouter key}"
  mkdir -m 700 elflodge-runner
  cd elflodge-runner
  umask 077
  cat > runner.env <<'EOF'
HUB_URL=`,
    },
    hub,
    {
      text: `
RUNNER_MODEL_PROVIDER=openrouter
RUNNER_MODEL_ID=openrouter/free
RUNNER_EXTENSIONS_DIR=/app/extensions
EOF
  printf 'RUNNER_REGISTRATION_KEY=%s\\n' >> runner.env \\
    '`,
    },
    { text: key ?? "<a registration key>", mark: key === undefined ? "placeholder" : "key" },
    {
      text: `'
  printf 'OPENROUTER_API_KEY=%s\\n' "$MY_KEY" >> runner.env
  docker run -d --name elflodge-runner --hostname "$(uname -n)" \\
    --security-opt seccomp=unconfined --security-opt systempaths=unconfined \\
    --security-opt apparmor=unconfined --memory 8g --restart unless-stopped \\
    --volume runner-data:/data --env-file runner.env \\
    ${IMAGE}
)`,
    },
  ];
}

type AddRunnerProps = {
  organizationName: string | undefined;
  managesKeys: boolean;
  runners: Runner[];
  shortId: (runner: Runner) => string;
  readFailed: boolean;
};

/**
 * The dialog that adds a Runner: the command to run on the machine that will run jobs, naming this
 * hub. Opening it creates nothing. A member who may manage keys creates a registration key from it
 * when they ask, an ordinary key that the API keys page lists; another member puts in a key they
 * hold. Closing it forgets the key, which is shown only this once.
 */
export function AddRunner(props: AddRunnerProps) {
  const [pending, setPending] = createSignal(false);
  return (
    <Dialog dismissible={!pending()} closeOnOutsidePress={false} container={document.body}>
      <DialogTrigger class="primary">Add Runner</DialogTrigger>
      <DialogContent class="is-wide" initialFocus="content">
        {() => <Instructions {...props} pending={pending()} onPendingChange={setPending} />}
      </DialogContent>
    </Dialog>
  );
}

function Instructions(
  props: AddRunnerProps & { pending: boolean; onPendingChange: (pending: boolean) => void },
) {
  // Each opening takes its own baseline and holds its own key until the content unmounts.
  const atOpen = new Set(untrack(() => props.runners).map((runner) => runner.id));
  // A heartbeat or a change in list order should not repeat a screen reader announcement.
  const newRunnerNames = createMemo(() =>
    props.runners
      .filter((runner) => !atOpen.has(runner.id))
      .map((runner) => `${runner.name} ${props.shortId(runner)}`)
      .toSorted()
      .join(", "),
  );
  const queryClient = useQueryClient();
  const [key, setKey] = createSignal<string>();
  const noteId = createUniqueId();
  const historyNoteId = createUniqueId();

  const { hostname, origin } = window.location;
  // The browser normalizes the URL host first: 127.1 becomes 127.0.0.1 and [0:0::1] becomes [::1].
  const loopback = isLoopback(hostname);
  const hub: Piece = loopback ? { text: HUB_PLACEHOLDER, mark: "placeholder" } : { text: origin };
  const command = () => dockerCommand(key(), hub);
  let copyCommand: HTMLButtonElement | undefined;

  createEffect(key, (shown) => {
    if (shown) copyCommand?.focus();
  });

  async function createKey() {
    props.onPendingChange(true);
    try {
      const created = await api.apiKeys.create({
        name: "Runner registration",
        permissions: { runner: ["register"] },
        expiresIn: REGISTRATION_KEY_LIFE_SECONDS,
      });
      setKey(created.key);
    } catch (error) {
      throw secretAnswerFailure(error);
    } finally {
      props.onPendingChange(false);
      void queryClient.invalidateQueries({ queryKey: orpc.apiKeys.list.key() });
    }
  }

  return (
    <>
      <DialogTitle class="dialog-h">Add Runner</DialogTitle>
      <div class="dialog-b">
        <p>Run this on the machine that will run jobs. It needs Docker.</p>
        <Show
          when={key()}
          fallback={
            <Button
              onClick={createKey}
              pendingAnnouncement="Working…"
              disabled={!props.managesKeys}
              focusableWhenDisabled
              render={(button, state) => (
                <div>
                  <Show
                    when={props.managesKeys || state.pending}
                    fallback={
                      <p>
                        Put a registration key you hold in place of{" "}
                        <mark class="placeholder">{"<a registration key>"}</mark>. Owners and admins
                        create them.
                      </p>
                    }
                  >
                    <p>
                      The Runner registers with a registration key. Create one that expires in a
                      day, or put in one you hold.
                    </p>
                  </Show>
                  <Show when={state.error} keyed>
                    {(error) => <Notice role="alert">{hubWriteFailureMessage(error)}</Notice>}
                  </Show>
                  {/* A session read can change the reader's role mid-press. The button stays while
                      its request is pending and while its refusal shows, so focus stays with the
                      request and its answer. A reader who lost permission cannot press it again. */}
                  <Show when={props.managesKeys || state.pending || !!state.error}>
                    <button {...button}>Create a registration key</button>
                  </Show>
                  <Show when={state.pending}>
                    <p class="note">Working…</p>
                  </Show>
                </div>
              )}
            />
          }
        >
          <p id={noteId} class="shown-once" role="note">
            <b>Shown this once:</b> the registration key in the command. Until it expires, in a day,
            anyone with it can register a Runner for {props.organizationName ?? "the Organization"}.
            API keys lists it, where it can be revoked.
          </p>
        </Show>
        <p>
          First, in Bash or zsh on that machine, run <code>read -rs MY_KEY</code> on its own. Paste
          your OpenRouter key and press Enter. The shell hides the input and leaves it out of
          history. The command below saves it in the private <code>runner.env</code>.{" "}
          <span id={historyNoteId}>
            When you run the command, your shell may save the registration key in its history.
          </span>
        </p>
        <div class="copyable">
          <pre
            class="code wraps command"
            tabindex="0"
            aria-label="The command to run on the machine"
          >
            {command().map((piece) =>
              piece.mark ? <mark class={piece.mark}>{piece.text}</mark> : piece.text,
            )}
          </pre>
          <CopyButton
            text={command()
              .map((piece) => piece.text)
              .join("")}
            label="Copy the command"
            describedBy={key() ? `${noteId} ${historyNoteId}` : historyNoteId}
            buttonRef={(button) => {
              copyCommand = button;
            }}
          />
        </div>
        <p>
          <Show
            when={loopback}
            fallback={
              <>
                <code>HUB_URL</code> is this page's address; change it if the Runner's machine
                reaches the hub at another.{" "}
              </>
            }
          >
            This page's address, <code>{origin}</code>, reaches the hub only from this machine. In
            place of <mark class="placeholder">{HUB_PLACEHOLDER}</mark>, put the address the
            Runner's machine reaches it at;{" "}
          </Show>
          <Button
            disabled={props.pending}
            render={(link) => (
              <a
                {...link}
                href={`https://github.com/elflodge/elflodge/blob/v${version}/docs/deploy.md#runners-on-other-machines`}
              />
            )}
          >
            Runners on other machines
          </Button>{" "}
          says how to open the hub to one.
        </p>
        <p>
          Its jobs run on OpenRouter's free models. To use another model, follow{" "}
          <Button
            disabled={props.pending}
            render={(link) => (
              <a
                {...link}
                href={`https://github.com/elflodge/elflodge/blob/v${version}/apps/runner/README.md`}
              />
            )}
          >
            the Runner's README
          </Button>
          .
        </p>
        <p role="status" aria-atomic="true" class={props.readFailed ? "vh" : "waiting-line"}>
          <Show when={!props.readFailed}>
            <span
              class={newRunnerNames() ? "mark mark-succeeded" : "mark mark-pending"}
              aria-hidden="true"
            />
            <Show
              when={newRunnerNames()}
              fallback={
                <span>
                  Waiting for a Runner to register. It will be listed here under its machine's name.
                </span>
              }
            >
              <span>
                New on this Hub since you opened this dialog:{" "}
                <span class="mono">{newRunnerNames()}</span>
              </span>
            </Show>
          </Show>
        </p>
      </div>
      <div class="dialog-f">
        <DialogClose
          render={(close) => (
            <Button {...close} disabled={props.pending} focusableWhenDisabled>
              Close
            </Button>
          )}
        />
      </div>
    </>
  );
}
