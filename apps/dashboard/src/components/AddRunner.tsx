import { isLoopbackHost } from "@better-auth/core/utils/host";
import type { JSX } from "@solidjs/web";
import { useQueryClient } from "@tanstack/solid-query";
import type { Runner } from "contract";
import { Show, createSignal, flush, onSettled } from "solid-js";

import { version } from "../../package.json";
import { api, hubFailureMessage } from "../api-client.ts";
import { orpc } from "../query.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Notice } from "./Notice.tsx";

/**
 * The Runner image of the dashboard's own release, which is the hub's: a release sets the version in
 * every package with the image tags, and a Runner newer than its hub is not supported
 * (docs/deploy.md).
 */
const IMAGE = `ghcr.io/elflodge/elflodge-runner:${version}`;

/** One day, the shortest time the hub lets a key live: a registration key is for the hosts at hand. */
const REGISTRATION_KEY_LIFE_SECONDS = 24 * 60 * 60;

const HUB_PLACEHOLDER = "<the hub's URL from that machine>";

/** A piece of a command: words typed as they are, a secret, or what the reader puts in its place. */
type Piece = string | { secret: string } | { placeholder: string };

/**
 * The Runner's settings, as docs/deploy.md writes them for a Runner on another machine: this hub,
 * the registration key, and OpenRouter's free models, which a reader can change for theirs.
 */
function settings(key: string | undefined, hub: Piece): Piece[] {
  return [
    "cat > runner.env <<EOF\nHUB_URL=",
    hub,
    "\nRUNNER_REGISTRATION_KEY=",
    key === undefined ? { placeholder: "<a registration key>" } : { secret: key },
    "\nRUNNER_MODEL_PROVIDER=openrouter\nRUNNER_MODEL_ID=openrouter/free\nOPENROUTER_API_KEY=",
    { placeholder: "<your key>" },
    "\nRUNNER_EXTENSIONS_DIR=/app/extensions\nEOF\n",
  ];
}

/**
 * Starts the Runner with Docker, as docs/deploy.md does. `--hostname` gives the container the host's
 * name, under which the hub lists the Runner.
 */
function dockerCommand(key: string | undefined, hub: Piece): Piece[] {
  return [
    ...settings(key, hub),
    `docker run -d --name elflodge-runner --hostname "$(uname -n)" \\
  --security-opt seccomp=unconfined --security-opt systempaths=unconfined \\
  --security-opt apparmor=unconfined --memory 8g --restart unless-stopped \\
  --volume runner-data:/data --env-file runner.env \\
  ${IMAGE}`,
  ];
}

/**
 * Starts the Runner with Docker Compose, with the options of the repository's compose.yaml. The
 * file is written by the shell, which puts the host's name in it, as Compose cannot.
 */
function composeCommand(key: string | undefined, hub: Piece): Piece[] {
  return [
    ...settings(key, hub),
    `cat > compose.yaml <<EOF
services:
  runner:
    image: ${IMAGE}
    hostname: $(uname -n)
    security_opt:
      - seccomp=unconfined
      - systempaths=unconfined
      - apparmor=unconfined
    mem_limit: 8g
    env_file: runner.env
    volumes:
      - runner-data:/data
    restart: unless-stopped
volumes:
  runner-data:
EOF
docker compose up -d`,
  ];
}

/** The command as typed, for copying. */
function commandText(pieces: Piece[]): string {
  return pieces
    .map((piece) =>
      typeof piece === "string" ? piece : "secret" in piece ? piece.secret : piece.placeholder,
    )
    .join("");
}

/** A command to copy, with its secret and what the reader fills in marked. */
function Command(props: {
  pieces: Piece[];
  label: string;
  copyLabel: string;
  buttonRef?: (button: HTMLButtonElement) => void;
}) {
  return (
    <div class="copyable">
      <pre class="code wraps command" tabindex="0" aria-label={props.label}>
        {props.pieces.map((piece): JSX.Element =>
          typeof piece === "string" ? (
            piece
          ) : "secret" in piece ? (
            <mark class="key">{piece.secret}</mark>
          ) : (
            <mark class="placeholder">{piece.placeholder}</mark>
          ),
        )}
      </pre>
      <CopyButton
        text={commandText(props.pieces)}
        label={props.copyLabel}
        buttonRef={props.buttonRef}
      />
    </div>
  );
}

/**
 * The dialog that adds a Runner: the command to run on the machine that will run jobs, naming this
 * hub. Opening it creates nothing. A member who may manage keys creates a registration key from it
 * when they ask, an ordinary key that the API keys page lists; another member puts in a key they
 * hold. Closing it forgets the key, which is shown only this once.
 */
export function AddRunner(props: {
  organizationName: string | undefined;
  managesKeys: boolean;
  registered?: Runner;
  shortId: (runner: Runner) => string;
  readFailed: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [key, setKey] = createSignal<string>();
  const [pending, setPending] = createSignal(false);
  const [failure, setFailure] = createSignal<string>();

  const { hostname, origin } = window.location;
  const loopback = isLoopbackHost(hostname);
  const hub = loopback ? { placeholder: HUB_PLACEHOLDER } : origin;
  let dialog: HTMLDialogElement | undefined;
  let copyCommand: HTMLButtonElement | undefined;

  async function createKey() {
    setPending(true);
    setFailure(undefined);
    try {
      const created = await api.apiKeys.create({
        name: "Runner registration",
        permissions: { runner: ["register"] },
        expiresIn: REGISTRATION_KEY_LIFE_SECONDS,
      });
      void queryClient.invalidateQueries({ queryKey: orpc.apiKeys.list.key() });
      if (!dialog?.open || !dialog.isConnected) return;
      setKey(created.key);
      flush();
      copyCommand?.focus();
    } catch (error) {
      if (dialog?.open && dialog.isConnected) setFailure(hubFailureMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <dialog
      class="is-wide"
      aria-labelledby="add-runner-heading"
      ref={(element) => {
        dialog = element;
        onSettled(() => element.showModal());
      }}
      onClose={props.onClose}
    >
      <form method="dialog">
        <h2 class="dialog-h" id="add-runner-heading">
          Add Runner
        </h2>
        <div class="dialog-b">
          <p>Run this on the machine that will run jobs. It needs Docker.</p>
          <Show
            when={key()}
            fallback={
              <Show
                when={props.managesKeys}
                fallback={
                  <p>
                    Put a registration key you hold in place of{" "}
                    <mark class="placeholder">{"<a registration key>"}</mark>. Owners and admins
                    create them.
                  </p>
                }
              >
                <div>
                  <p>
                    The Runner registers with a registration key. Create one that expires in a day,
                    or put in one you hold.
                  </p>
                  <Show when={failure()}>
                    {(message) => <Notice role="alert">{message()}</Notice>}
                  </Show>
                  <p>
                    <button type="button" disabled={pending()} onClick={() => void createKey()}>
                      Create a registration key
                    </button>
                  </p>
                </div>
              </Show>
            }
          >
            <p class="shown-once" role="note">
              <b>Shown this once:</b> the registration key in the command. Until it expires, in a
              day, anyone with it can register a Runner for{" "}
              {props.organizationName ?? "the Organization"}. API keys lists it, where it can be
              revoked.
            </p>
          </Show>
          <Command
            pieces={dockerCommand(key(), hub)}
            label="The command to run on the machine"
            copyLabel="Copy the command"
            buttonRef={(button) => {
              copyCommand = button;
            }}
          />
          <details>
            <summary>With Docker Compose instead</summary>
            <Command
              pieces={composeCommand(key(), hub)}
              label="The commands to run on the machine, with Docker Compose"
              copyLabel="Copy the Compose commands"
            />
          </details>
          <p>
            <Show
              when={loopback}
              fallback={
                <>
                  <code>HUB_URL</code> is this page's address; change it if the Runner's machine
                  reaches the hub at another.
                </>
              }
            >
              This page's address, <code>{origin}</code>, reaches the hub only from this machine. In
              place of <mark class="placeholder">{HUB_PLACEHOLDER}</mark>, put the address the
              Runner's machine reaches it at;{" "}
              <a
                href={`https://github.com/elflodge/elflodge/blob/v${version}/docs/deploy.md#runners-on-other-machines`}
              >
                Runners on other machines
              </a>{" "}
              says how to open the hub to one.
            </Show>
          </p>
          <p>
            Its jobs run on OpenRouter's free models: put your OpenRouter key in place of{" "}
            <mark class="placeholder">{"<your key>"}</mark>, or name another model as{" "}
            <a href={`https://github.com/elflodge/elflodge/blob/v${version}/apps/runner/README.md`}>
              the Runner's README
            </a>{" "}
            describes.
          </p>
          <Show when={!props.readFailed}>
            <Show
              when={props.registered}
              fallback={
                <p class="waiting-line">
                  <span class="mark mark-pending" aria-hidden="true" />
                  <span>
                    Waiting for a Runner to register. It will be listed here under its machine's
                    name.
                  </span>
                </p>
              }
            >
              {(runner) => (
                <p class="waiting-line" role="status">
                  <span class="mark mark-succeeded" aria-hidden="true" />
                  <span>
                    <span class="mono">{runner().name}</span>{" "}
                    <span class="sid">{props.shortId(runner())}</span> has registered.
                  </span>
                </p>
              )}
            </Show>
          </Show>
        </div>
        <div class="dialog-f">
          <button value="close">Close</button>
        </div>
      </form>
    </dialog>
  );
}
