import { Link } from "@tanstack/solid-router";

import { FallbackPage } from "./FallbackPage.tsx";

export function NotFound() {
  return (
    <FallbackPage heading="Not found">
      <p class="prose">The page you are looking for does not exist.</p>
      <p class="prose">
        <Link to="/" class="stands-alone">
          Home
        </Link>
      </p>
    </FallbackPage>
  );
}
