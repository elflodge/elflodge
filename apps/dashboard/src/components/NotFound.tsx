import { Link } from "@tanstack/solid-router";

import { BrandMark } from "./BrandMark.tsx";

export function NotFound() {
  return (
    <main id="main" class="page is-alone">
      <BrandMark alt="" />
      <h1>Not found</h1>
      <p class="prose">The page you are looking for does not exist.</p>
      <p class="prose">
        <Link to="/">Home</Link>
      </p>
    </main>
  );
}
