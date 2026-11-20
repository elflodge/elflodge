import type { JSX } from "@solidjs/web";
import { createContext, useContext } from "solid-js";

import { BrandMark } from "./BrandMark.tsx";

/** Whether what reads it is drawn inside the shell, which then has the bar and `main` around it. */
export const InShell = createContext(false);

/**
 * A page shown in place of the one asked for, which failed or was not found. Inside the shell it is
 * a page like any other there; outside, it brings its own `main` and stands under the mark.
 */
export function FallbackPage(props: {
  heading: string;
  children: JSX.Element;
  headingRef?: (element: HTMLHeadingElement) => void;
}) {
  return useContext(InShell) ? (
    <>
      <div class="head">
        <h1 tabindex={props.headingRef ? -1 : undefined} ref={props.headingRef}>
          {props.heading}
        </h1>
      </div>
      {props.children}
    </>
  ) : (
    <main id="main" class="page is-alone">
      <BrandMark alt="" />
      <h1 tabindex={props.headingRef ? -1 : undefined} ref={props.headingRef}>
        {props.heading}
      </h1>
      {props.children}
    </main>
  );
}
