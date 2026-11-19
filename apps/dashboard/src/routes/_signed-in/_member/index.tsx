import { createFileRoute } from "@tanstack/solid-router";

export const Route = createFileRoute("/_signed-in/_member/")({
  component: Home,
});

function Home() {
  return (
    <>
      <div class="head">
        <h1>Connected to your hub</h1>
      </div>
      <p class="prose">You are signed in to this hub.</p>
    </>
  );
}
