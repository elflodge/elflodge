import type { JSX } from "@solidjs/web";
import { HeadContent, Scripts } from "@tanstack/solid-router";

/**
 * The document the root route renders every page in. A module of its own so that the in-page tests,
 * which mount the app inside a document that exists already, can put the head's content in its
 * place: Solid cannot create `<html>`, `<head>` or `<body>` on the client (solidjs/solid#3259).
 */
export function RootDocument(props: { children: JSX.Element }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {props.children}
        <Scripts />
      </body>
    </html>
  );
}
