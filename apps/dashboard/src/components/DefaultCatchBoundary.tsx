import { useRouter } from "@tanstack/solid-router";
import type { ErrorComponentProps } from "@tanstack/solid-router";
import { asError } from "contract";

import { FallbackPage } from "./FallbackPage.tsx";
import { Notice } from "./Notice.tsx";

export function DefaultCatchBoundary(props: ErrorComponentProps<unknown>) {
  const router = useRouter();

  return (
    <FallbackPage heading="This page could not be shown">
      <Notice role="alert">{asError(props.error).message}</Notice>
      <p>
        <button type="button" class="primary" onClick={() => void router.invalidate()}>
          Try again
        </button>
      </p>
    </FallbackPage>
  );
}
