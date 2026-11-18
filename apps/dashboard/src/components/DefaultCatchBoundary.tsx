import { ErrorComponent, useRouter } from "@tanstack/solid-router";
import type { ErrorComponentProps } from "@tanstack/solid-router";

export function DefaultCatchBoundary(props: ErrorComponentProps) {
  const router = useRouter();

  return (
    <main id="main" class="page is-alone">
      <ErrorComponent error={props.error} />
      <p>
        <button type="button" onClick={() => void router.invalidate()}>
          Try again
        </button>
      </p>
    </main>
  );
}
