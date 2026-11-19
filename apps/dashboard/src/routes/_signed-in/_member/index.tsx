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
      <p class="prose">
        You are signed in to this hub. The <a href="/spec.json">OpenAPI document</a> describes its
        API as JSON, for an API client or a code generator to read.
      </p>
    </>
  );
}
