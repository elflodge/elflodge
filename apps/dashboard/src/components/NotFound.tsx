import { Link } from "@tanstack/solid-router";

export function NotFound() {
  return (
    <main>
      <h1>Not found</h1>
      <p>The page you are looking for does not exist.</p>
      <p>
        <Link to="/">Home</Link>
      </p>
    </main>
  );
}
