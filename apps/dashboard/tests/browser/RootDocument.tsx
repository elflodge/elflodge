import type { JSX } from "@solidjs/web";
import { HeadContent } from "@tanstack/solid-router";

/**
 * The app's document, in the document the tests run in, which exists already: the head's content,
 * the route's title, styles and icons, which Solid's head registry puts in that document's head,
 * and the page.
 */
export function RootDocument(props: { children: JSX.Element }) {
  return (
    <>
      <HeadContent />
      {props.children}
    </>
  );
}
