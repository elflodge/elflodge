import type { JSX } from "@solidjs/web";
import { useQueryClient } from "@tanstack/solid-query";
import { Show, createSignal } from "solid-js";

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

/** The hub's URL: the page's own origin, which serves it (ADR 0043). */
function hubUrl() {
  return window.location.origin;
}

/** A piece of a command: words typed as they are, a secret, or what the reader puts in its place. */
type Piece = string | { secret: string } | { placeholder: string };

/**
 * The Runner's settings, as docs/deploy.md writes them for a Runner on another machine: this hub,
 * the registration key, and OpenRouter's free models, which a reader can change for theirs.
 */
function settings(key: string | undefined): Piece[] {
  return [
    `cat > runner.env <<EOF\nHUB_URL=${hubUrl()}\nRUNNER_REGISTRATION_KEY=`,
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
function dockerCommand(key: string | undefined): Piece[] {
  return [
    ...settings(key),
    `docker run -d --name elflodge-runner --hostname "$(uname -n)" --security-opt seccomp=unconfined \\
  --security-opt systempaths=unconfined --security-opt apparmor=unconfined --memory 8g \\
  --restart unless-stopped --volume runner-data:/data --env-file runner.env \\
  ${IMAGE}`,
  ];
}

/**
 * Starts the Runner with Docker Compose, with the options of the repository's compose.yaml. The
 * file is written by the shell, which puts the host's name in it, as Compose cannot.
 */
function composeCommand(key: string | undefined): Piece[] {
  return [
    ...settings(key),
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
function Command(props: { pieces: Piece[]; label: string; copyLabel: string }) {
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
      <CopyButton text={commandText(props.pieces)} label={props.copyLabel} />
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
  dialogRef: (element: HTMLDialogElement) => void;
}) {
  const queryClient = useQueryClient();
  const [key, setKey] = createSignal<string>();
  const [pending, setPending] = createSignal(false);
  const [failure, setFailure] = createSignal<string>();

  async function createKey() {
    setPending(true);
    setFailure(undefined);
    try {
      const created = await api.apiKeys.create({
        name: "Runner registration",
        permissions: { runner: ["register"] },
        expiresIn: REGISTRATION_KEY_LIFE_SECONDS,
      });
      setKey(created.key);
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
      aria-labelledby="add-runner-heading"
      ref={props.dialogRef}
      onClose={() => {
        setKey(undefined);
        setFailure(undefined);
      }}
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
            pieces={dockerCommand(key())}
            label="The command to run on the machine"
            copyLabel="Copy the command"
          />
          <details>
            <summary>With Docker Compose instead</summary>
            <Command
              pieces={composeCommand(key())}
              label="The commands to run on the machine, with Docker Compose"
              copyLabel="Copy the Compose commands"
            />
          </details>
          <p>
            Its jobs run on OpenRouter's free models: put your OpenRouter key in place of{" "}
            <mark class="placeholder">{"<your key>"}</mark>, or name another model as{" "}
            <a href={`https://github.com/elflodge/elflodge/blob/v${version}/apps/runner/README.md`}>
              the Runner's README
            </a>{" "}
            describes. Once it registers, this page lists it under the machine's name.
          </p>
        </div>
        <div class="dialog-f">
          <button value="close">Close</button>
        </div>
      </form>
    </dialog>
  );
}
