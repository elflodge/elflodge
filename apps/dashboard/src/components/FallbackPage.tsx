import type { JSX } from "@solidjs/web";
import { createContext, onSettled, useContext } from "solid-js";

import { focusIfLost } from "../form.ts";
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
  focusHeading?: boolean;
}) {
  const heading = (
    <h1
      tabindex={props.focusHeading ? -1 : undefined}
      ref={(element) => {
        if (props.focusHeading) onSettled(() => focusIfLost(element));
      }}
    >
      {props.heading}
    </h1>
  );
  return useContext(InShell) ? (
    <>
      <div class="head">{heading}</div>
      {props.children}
    </>
  ) : (
    <main id="main" class="page is-alone">
      <BrandMark alt="" />
      {heading}
      {props.children}
    </main>
  );
}
