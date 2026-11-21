import type { JSX } from "@solidjs/web";
import { useRouter, type ErrorComponentProps } from "@tanstack/solid-router";
import { Show } from "solid-js";

import { failureDetailSuffix, HubReadError } from "../api-client.ts";
import { focusIfLost } from "../form.ts";
import { TIME_SECONDS, timeZoneNote } from "../format.ts";
import { DefaultCatchBoundary } from "./DefaultCatchBoundary.tsx";
import { FallbackPage } from "./FallbackPage.tsx";
import { Instant } from "./Instant.tsx";
import { Notice } from "./Notice.tsx";

export function FailedReadNotice(props: {
  what: string;
  detail: string;
  /** Missing only while a `Show` that tests an optional failure takes this away. */
  failedAt: number | undefined;
  readAt?: number;
  format?: Intl.DateTimeFormat;
}) {
  return (
    <Notice role="alert">
      {props.what} could not be read at{" "}
      <Instant
        value={props.failedAt === undefined ? undefined : new Date(props.failedAt)}
        format={props.format ?? TIME_SECONDS}
      />
      {failureDetailSuffix(props.detail)}
      <Show when={props.readAt}>
        {(readAt) => (
          <>
            {" "}
            What is shown is from the read at{" "}
            <Instant value={new Date(readAt())} format={props.format ?? TIME_SECONDS} />.
          </>
        )}
      </Show>
    </Notice>
  );
}

export function ReadErrorPage(
  props: ErrorComponentProps<unknown> & {
    heading: string;
    note?: string;
    children?: JSX.Element;
  },
) {
  const router = useRouter();
  const failure = props.error;
  if (!(failure instanceof HubReadError)) {
    return <DefaultCatchBoundary {...props} />;
  }
  async function retry(event: MouseEvent & { currentTarget: HTMLButtonElement }) {
    const button = event.currentTarget;
    const address = location.href;
    await router.invalidate();
    if (button.isConnected || location.href !== address) return;
    const heading = document.querySelector<HTMLElement>("main h1");
    if (heading) {
      heading.tabIndex = -1;
      focusIfLost(heading);
    }
  }
  return (
    <FallbackPage heading={props.heading} focusHeading>
      <p class="note">
        {timeZoneNote()} {props.note}
      </p>
      <FailedReadNotice what={failure.what} detail={failure.detail} failedAt={failure.failedAt} />
      <p>
        <button type="button" class="primary" onClick={retry}>
          Try again
        </button>
      </p>
      {props.children}
    </FallbackPage>
  );
}
