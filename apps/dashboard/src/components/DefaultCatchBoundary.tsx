import { useRouter } from "@tanstack/solid-router";
import type { ErrorComponentProps } from "@tanstack/solid-router";
import { Button } from "@ui-sdk/solid/button";
import { asError } from "contract";

import { FallbackPage } from "./FallbackPage.tsx";
import { Notice } from "./Notice.tsx";

export function DefaultCatchBoundary(props: ErrorComponentProps<unknown>) {
  const router = useRouter();

  return (
    <FallbackPage heading="This page could not be shown">
      <Notice role="alert">{asError(props.error).message}</Notice>
      <p>
        <Button class="primary" onClick={() => router.invalidate()}>
          Try again
        </Button>
      </p>
    </FallbackPage>
  );
}
