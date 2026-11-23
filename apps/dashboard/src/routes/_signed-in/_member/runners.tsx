import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query";
import { createFileRoute } from "@tanstack/solid-router";
import {
  AlertDialogTrigger,
  createAlertDialogController,
  type AlertDialogController,
} from "@ui-sdk/solid/alert-dialog";
import { type Runner, type RunnerCapabilities, problemOf } from "contract";
import { For, Show, createMemo, createSignal, deep, flush, latest } from "solid-js";

import { api, hubFailureDetail, readFromHub } from "../../../api-client.ts";
import { AddRunner } from "../../../components/AddRunner.tsx";
import { ConfirmDialog } from "../../../components/ConfirmDialog.tsx";
import { FailedReadNotice, ReadErrorPage } from "../../../components/FailedReadNotice.tsx";
import { Instant, LastContact } from "../../../components/Instant.tsx";
import { LoadingRunners } from "../../../components/LoadingRunners.tsx";
import { Notice } from "../../../components/Notice.tsx";
import { formatCount, plural, timeZoneNote } from "../../../format.ts";
import { memberPageHead } from "../../../page-title.ts";
import { REFRESH_INTERVAL_MS, orpc, writeAbsence } from "../../../query.ts";
import { shortIds } from "../../../short-ids.ts";

/** A Runner to remove, named as the member saw it when they pressed Remove. */
type Removal = { id: string; name: string; sid: string };

const CONNECTION_NOTE =
  "Connected means the hub has heard from the Runner in about the last two minutes.";

export const Route = createFileRoute("/_signed-in/_member/runners")({
  head: ({ match }) => memberPageHead(match.context, "Runners"),
  loader: async ({ context }) => {
    if (!context.member) return;
    await readFromHub("The Runners", () =>
      context.queryClient.query(orpc.runners.list.queryOptions({ staleTime: "static" })),
    );
  },
  pendingComponent: LoadingRunners,
  errorComponent: (props) => <ReadErrorPage {...props} heading="Runners" note={CONNECTION_NOTE} />,
  component: Runners,
});

function Runners() {
  const context = Route.useRouteContext();
  const queryClient = useQueryClient();
  const runners = useQuery(() =>
    orpc.runners.list.queryOptions({ refetchInterval: REFRESH_INTERVAL_MS }),
  );
  // While a read of the list is in flight, `runners.data` is pending, and Solid can hold the
  // confirmation's writes with a render pass here that reads it until the read lands: read directly
  // by the rows, its opening waited; by the rest of the page alone, its "Working…" did.
  const list = createMemo(() => latest(() => deep(runners.data)));
  // Each removal mounts a fresh status, even when its message repeats.
  const [removed, setRemoved] = createSignal<{ message: string }>();
  const ids = createMemo(() => shortIds(list().map((runner) => runner.id)));
  const shortId = (runner: Runner) => ids().get(runner.id) ?? runner.id;

  const removing = useMutation(() => orpc.runners.delete.mutationOptions());
  const confirmRemove = createAlertDialogController<Removal>();
  let notice: HTMLElement | undefined;

  async function remove(runner: Removal) {
    const label = `${runner.name} ${runner.sid}`;
    const queryKey = orpc.runners.list.queryKey();
    const reread = () => queryClient.invalidateQueries({ queryKey, exact: true });
    let removal;
    try {
      removal = await removing.mutate({ id: runner.id });
    } catch (error) {
      if (problemOf(error)?.status !== 404) {
        // Even a refused removal can mean the Runner is gone since the list was read.
        void reread();
        throw error;
      }
      // One read decides whether it is already gone, while the dialog waits: tried once, within the
      // hub deadline, offline too. Not through Query: `queryClient.query` with its own retry and
      // networkMode leaves those options on the query, and an invalidation, which fetches with the
      // query's options, would then try the list once and without waiting for the network, until the
      // page's own observer reads it again.
      const current = await api.runners.list().catch(() => undefined);
      // A read that fails, or outlasts the hub deadline, decides nothing: the refusal stands.
      if (!current) {
        void reread();
        throw error;
      }
      if (current.some((item) => item.id === runner.id)) throw error;
      await writeAbsence(queryClient, queryKey, (cached) =>
        cached.filter((item) => item.id !== runner.id),
      );
      setRemoved({ message: `${label} is already gone.` });
      // On the page before the dialog closes and focus moves to it.
      flush();
      return;
    }
    setRemoved({
      message: removalSummary(label, removal.endedJobs.length, removal.jobsWithFilesLeft.length),
    });
    // Render the outcome before starting a background read that may need to retry. The reads start
    // before UI SDK closes the dialog, which is no matter: nothing the dialog, the notice or a row
    // reads waits for them.
    flush();
    void reread();
    // Jobs ended by the removal are stale wherever they are shown.
    void queryClient.invalidateQueries({ queryKey: orpc.jobs.key() });
  }

  return (
    <>
      <div class="head">
        <h1>Runners</h1>
        <div class="controls">
          <AddRunner
            organizationName={context().member?.organization.name}
            managesKeys={context().managesKeys}
            runners={list()}
            readFailed={runners.isError}
            shortId={shortId}
          />
        </div>
      </div>
      {/* Keep the note before notices and mounted so it stays inert if a Runner arrives. */}
      <div hidden={!runners.isError && list().length === 0}>
        <p class="note">
          {timeZoneNote()} {CONNECTION_NOTE}
        </p>
      </div>
      <Show when={removed()} keyed>
        {(removal) => (
          <Notice
            role="status"
            focusRef={(element) => {
              notice = element;
            }}
          >
            {removal.message}
          </Notice>
        )}
      </Show>
      {/* A read after the first that failed: what is shown is from an earlier one. */}
      <Show when={runners.isError}>
        <FailedReadNotice
          what="The Runners"
          detail={hubFailureDetail(runners.error)}
          failedAt={runners.errorUpdatedAt}
          readAt={runners.dataUpdatedAt}
        />
      </Show>
      {/* A Runner can register while Add Runner is open, the list then replacing "No Runners
          yet", with a notice showing or not. Both list states sit in one container, which the
          open dialog has made inert, so the new Runner's Remove stays behind the dialog. */}
      <div>
        <Show
          when={list().length}
          fallback={
            <div class="empty">
              <h2>No Runners yet</h2>
              <p>
                A Runner runs jobs. Add one with the command Add Runner gives, and it is listed here
                once it registers.
              </p>
            </div>
          }
        >
          <RunnerList
            runners={list()}
            managesKeys={context().managesKeys}
            confirmRemove={confirmRemove}
            readAt={runners.dataUpdatedAt}
            shortId={shortId}
          />
        </Show>
      </div>
      <ConfirmDialog
        controller={confirmRemove}
        heading={(runner) => (
          <>
            Remove <span class="mono">{runner.name}</span> <span class="sid">{runner.sid}</span>?
          </>
        )}
        confirm={(runner) => `Remove ${runner.name} ${runner.sid}`}
        act={remove}
        notice={() => notice}
      >
        {() => (
          <>
            <p>Its key stops working and its connection is dropped at once.</p>
            <p>
              <b>Every job it holds that has not ended, ends now</b>: failed as{" "}
              <code>runnerRemoved</code>, or cancelled where a cancel was waiting. None of them can
              be resumed, and they may still run on the host unseen.
            </p>
          </>
        )}
      </ConfirmDialog>
    </>
  );
}

/** What a removal did, for the notice that says it was done. */
function removalSummary(label: string, ended: number, filesLeft: number): string {
  const endedWords =
    ended === 0
      ? "It held no unfinished jobs."
      : `It ended ${formatCount(ended)} unfinished ${plural(ended, "job", "jobs")}.`;
  const filesWords =
    filesLeft === 0
      ? ""
      : ` Its host may still hold the files of ${formatCount(filesLeft)} ${plural(filesLeft, "job", "jobs")}.`;
  return `${label} is removed. ${endedWords}${filesWords}`;
}

function RunnerList(props: {
  runners: Runner[];
  readAt: number;
  shortId: (runner: Runner) => string;
  managesKeys: boolean;
  confirmRemove: AlertDialogController<Removal>;
}) {
  return (
    <ul class="runners">
      {/* Keyed by ID, so that a read again keeps each record. */}
      <For each={props.runners} keyed={(runner) => runner.id}>
        {(runner) => {
          const sid = () => props.shortId(runner());
          return (
            <li class="runner" id={runner().id}>
              <div class="runner-id">
                <h2 class="runner-name">
                  <span class="mono">{runner().name}</span> <span class="sid">{sid()}</span>
                </h2>
                <Show
                  when={runner().connected}
                  fallback={
                    <>
                      <p class="conn is-off">
                        <span class="mark mark-disconnected" aria-hidden="true" />
                        Not connected
                      </p>
                      <p class="note is-unknown">
                        <span class="mark mark-unknown" aria-hidden="true" />
                        <span>Its queued and running jobs show status unknown.</span>
                      </p>
                    </>
                  }
                >
                  <p class="conn">
                    <span class="mark mark-connected" aria-hidden="true" />
                    Connected
                  </p>
                </Show>
                <dl>
                  <dt>Last contact</dt>
                  <dd>
                    <LastContact at={runner().lastSeenAt} readAt={props.readAt} />
                  </dd>
                  <dt>Registered</dt>
                  <dd>
                    <Instant value={runner().registeredAt} />
                  </dd>
                </dl>
              </div>
              <Capabilities capabilities={runner().capabilities} />
              <Show when={props.managesKeys}>
                <div class="runner-ctl">
                  <AlertDialogTrigger
                    controller={props.confirmRemove}
                    payload={{ id: runner().id, name: runner().name, sid: sid() }}
                    class="danger"
                    aria-label={`Remove ${runner().name} ${sid()}`}
                  >
                    Remove
                  </AlertDialogTrigger>
                </div>
              </Show>
            </li>
          );
        }}
      </For>
    </ul>
  );
}

/** What a Runner reported its jobs can do, as the hub gives it. */
function Capabilities(props: { capabilities: RunnerCapabilities | null }) {
  return (
    <Show
      when={props.capabilities}
      fallback={<p class="note">It has reported nothing this hub can read.</p>}
      keyed
    >
      {(capabilities) => (
        <dl>
          <dt>Version</dt>
          <dd class="mono">{capabilities.runnerVersion}</dd>
          <dt>Model its jobs start on</dt>
          <dd>
            <span class="mono">
              {capabilities.model.provider} / {capabilities.model.modelId}
            </span>{" "}
            <span class="unit">thinking {capabilities.model.thinkingLevel}</span>
          </dd>
          <dt>Extensions</dt>
          <dd>
            <Show when={capabilities.extensions.length > 0} fallback="None">
              <ul class="plain">
                <For each={capabilities.extensions}>
                  {(extension) => (
                    <li class="mono">
                      {extension.name}
                      {extension.version === undefined ? "" : ` ${extension.version}`}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </dd>
          <dt>Web search</dt>
          <dd>{webSearchWords(capabilities.webSearch)}</dd>
        </dl>
      )}
    </Show>
  );
}

/** Whether jobs may search the web, and through whom, as the Runner reported it. */
function webSearchWords(webSearch: RunnerCapabilities["webSearch"]) {
  if (webSearch === undefined) return "Not reported";
  if (!webSearch.enabled) return "Off";
  return (
    <>
      {webSearch.allowedProviders === undefined ? (
        "On, any provider"
      ) : (
        <>
          On, only{" "}
          {webSearch.allowedProviders.map((provider, i) => (
            <>
              {i > 0 ? ", " : ""}
              <code>{provider}</code>
            </>
          ))}
        </>
      )}
      {webSearch.openai === undefined
        ? ""
        : webSearch.openai.mayUseApiKey
          ? "; OpenAI searches may be paid by an API key"
          : "; OpenAI searches never paid by an API key"}
    </>
  );
}
