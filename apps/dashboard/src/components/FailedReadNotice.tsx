import type { JSX } from "@solidjs/web";
import { useRouter, type ErrorComponentProps } from "@tanstack/solid-router";
import { Show, onSettled } from "solid-js";

import { HubReadError } from "../api-client.ts";
import { focusIfLost } from "../form.ts";
import { TIME_SECONDS, timeZoneNote } from "../format.ts";
import { DefaultCatchBoundary } from "./DefaultCatchBoundary.tsx";
import { FallbackPage } from "./FallbackPage.tsx";
import { Instant } from "./Instant.tsx";
import { Notice } from "./Notice.tsx";

export function FailedReadNotice(props: {
  what: string;
  detail: string;
  failedAt: number;
  readAt?: number;
}) {
  return (
    <Notice role="alert">
      {props.what} could not be read at{" "}
      <Instant value={new Date(props.failedAt)} format={TIME_SECONDS} />: {props.detail}
      <Show when={props.readAt}>
        {(readAt) => (
          <>
            {" "}
            What is shown is from the read at{" "}
            <Instant value={new Date(readAt())} format={TIME_SECONDS} />.
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
  return (
    <FallbackPage
      heading={props.heading}
      headingRef={(heading) => onSettled(() => focusIfLost(heading))}
    >
      <p class="note">
        {timeZoneNote()} {props.note}
      </p>
      <FailedReadNotice what={failure.what} detail={failure.detail} failedAt={failure.failedAt} />
      <p>
        <button type="button" class="primary" onClick={() => void router.invalidate()}>
          Try again
        </button>
      </p>
      {props.children}
    </FallbackPage>
  );
}
