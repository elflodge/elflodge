import { createFileRoute } from "@tanstack/solid-router";

export const Route = createFileRoute("/_signed-in/")({
  component: Home,
});

function Home() {
  return (
    <>
      <h1>Connected to your hub</h1>
      <p>
        You are signed in to this hub. The <a href="/docs">API reference</a> describes everything
        the hub does.
      </p>
    </>
  );
}
