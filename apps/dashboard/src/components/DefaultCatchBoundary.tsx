import { useRouter } from "@tanstack/solid-router";
import type { ErrorComponentProps } from "@tanstack/solid-router";
import ensureError from "ensure-error";

import { FallbackPage } from "./FallbackPage.tsx";
import { Notice } from "./Notice.tsx";

export function DefaultCatchBoundary(props: ErrorComponentProps) {
  const router = useRouter();

  return (
    <FallbackPage heading="This page could not be shown">
      <Notice role="alert">{ensureError(props.error).message}</Notice>
      <p>
        <button type="button" class="primary" onClick={() => void router.invalidate()}>
          Try again
        </button>
      </p>
    </FallbackPage>
  );
}
