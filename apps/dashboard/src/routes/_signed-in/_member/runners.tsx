import { useQuery, useQueryClient } from "@tanstack/solid-query";
import { createFileRoute } from "@tanstack/solid-router";
import { type Runner, type RunnerCapabilities, problemOf } from "contract";
import { For, Show, createMemo, createSignal, flush } from "solid-js";

import { api, hubFailureDetail, hubFailureMessage, readFromHub } from "../../../api-client.ts";
import { AddRunner } from "../../../components/AddRunner.tsx";
import { ConfirmAction } from "../../../components/ConfirmAction.tsx";
import { FailedReadNotice, ReadErrorPage } from "../../../components/FailedReadNotice.tsx";
import { Instant, LastContact } from "../../../components/Instant.tsx";
import { LoadingRunners } from "../../../components/LoadingRunners.tsx";
import { Notice } from "../../../components/Notice.tsx";
import { focusAfterRowDrops } from "../../../form.ts";
import { formatCount, plural, timeZoneNote } from "../../../format.ts";
import { memberPageHead } from "../../../page-title.ts";
import { REFRESH_INTERVAL_MS, orpc } from "../../../query.ts";
import { shortIds } from "../../../short-ids.ts";

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
  const [actionFailure, setActionFailure] = createSignal<string>();
  const [removed, setRemoved] = createSignal<{ id: string; message: string }>();
  const [runnersAtOpen, setRunnersAtOpen] = createSignal<ReadonlySet<string>>();
  const ids = createMemo(() => shortIds(runners.data.map((runner) => runner.id)));
  const shortId = (runner: Runner) => ids().get(runner.id) ?? runner.id;

  function openAddRunner() {
    setRunnersAtOpen(new Set(ids().keys()));
  }

  async function remove(runner: Runner, label: string) {
    setActionFailure(undefined);
    const queryKey = orpc.runners.list.queryKey();
    const reread = () => queryClient.invalidateQueries({ queryKey, exact: true });
    let removal;
    try {
      removal = await api.runners.delete({ id: runner.id });
    } catch (error) {
      // Even a refused removal can mean the Runner is gone since the list was read.
      const refreshed = reread();
      if (problemOf(error)?.status !== 404) return hubFailureMessage(error);
      await refreshed;
      const list = queryClient.getQueryState(queryKey);
      if (!list?.data || list.isInvalidated || list.data.some((item) => item.id === runner.id))
        return hubFailureMessage(error);
      setRemoved({ id: runner.id, message: `${label} is already gone.` });
      return undefined;
    }
    setRemoved({
      id: runner.id,
      message: removalSummary(label, removal.endedJobs.length, removal.jobsWithFilesLeft.length),
    });
    // Render the outcome before starting a background read that may need to retry.
    flush();
    void reread();
    // Jobs ended by the removal are stale wherever they are shown.
    void queryClient.invalidateQueries({ queryKey: orpc.jobs.key() });
    return undefined;
  }

  return (
    <>
      <div class="head">
        <h1>Runners</h1>
        <div class="controls">
          <button type="button" class="primary" onClick={openAddRunner}>
            Add Runner
          </button>
        </div>
      </div>
      <Show when={runners.isError || runners.data.length}>
        <p class="note">
          {timeZoneNote()} {CONNECTION_NOTE}
        </p>
      </Show>
      <Show when={removed()} keyed>
        {(removal) => (
          <Notice
            role="status"
            focusRef={(element) => focusAfterRowDrops(element, () => ids().has(removal.id))}
          >
            {removal.message}
          </Notice>
        )}
      </Show>
      <Show when={actionFailure()} keyed>
        {(message) => <Notice role="alert">{message}</Notice>}
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
      <Show
        when={runners.data.length}
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
          runners={runners.data}
          managesKeys={context().managesKeys}
          remove={remove}
          reportPageFailure={setActionFailure}
          readAt={runners.dataUpdatedAt}
          shortId={shortId}
        />
      </Show>
      <Show when={runnersAtOpen()} keyed>
        {(atOpen) => (
          <AddRunner
            organizationName={context().member?.organization.name}
            managesKeys={context().managesKeys}
            registered={runners.data.find((runner) => !atOpen.has(runner.id))}
            readFailed={runners.isError}
            shortId={shortId}
            onClose={() => setRunnersAtOpen(undefined)}
          />
        )}
      </Show>
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
  reportPageFailure: (message: string) => void;
  remove: (runner: Runner, label: string) => Promise<string | undefined>;
}) {
  return (
    <ul class="runners">
      {/* Keyed by ID, so that a read again keeps each record, and a dialog open in it. */}
      <For each={props.runners} keyed={(runner) => runner.id}>
        {(runner) => {
          const sid = () => props.shortId(runner());
          const label = () => `${runner().name} ${sid()}`;
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
                  <ConfirmAction
                    trigger="Remove"
                    reportPageFailure={(message) =>
                      props.reportPageFailure(`Remove ${label()}: ${message}`)
                    }
                    triggerLabel={`Remove ${label()}`}
                    heading={
                      <>
                        Remove <span class="mono">{runner().name}</span>{" "}
                        <span class="sid">{sid()}</span>?
                      </>
                    }
                    confirm={`Remove ${label()}`}
                    act={() => props.remove(runner(), label())}
                  >
                    <p>Its key stops working and its connection is dropped at once.</p>
                    <p>
                      <b>Every job it holds that has not ended, ends now</b>: failed as{" "}
                      <code>runnerRemoved</code>, or cancelled where a cancel was waiting. None of
                      them can be resumed, and they may still run on the host unseen.
                    </p>
                  </ConfirmAction>
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
