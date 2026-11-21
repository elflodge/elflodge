import { size } from "effect/Iterable";
import { linesIterator } from "effect/String";
import { Show, createMemo, createSignal, createUniqueId, flush, onSettled } from "solid-js";

import { formatCount } from "../format.ts";

export function countLines(text: string) {
  return size(linesIterator(text));
}

/** Shorten the text by rendered lines: one logical line can fill a phone screen when it wraps. */
export function TextPreview(props: {
  id?: string;
  text: string;
  label: string;
  prose?: boolean;
  wraps?: boolean;
  wholeTextLabel?: string;
}) {
  const id = props.id ?? createUniqueId();
  const lines = createMemo(() => countLines(props.text));
  const [limitExceeded, setLimitExceeded] = createSignal<number>();
  const [expanded, setExpanded] = createSignal(false);
  let text: HTMLElement | undefined;

  onSettled(() => {
    const element = text;
    if (!element) return undefined;
    const observer = new ResizeObserver(() => {
      const style = getComputedStyle(element);
      const limit = Number(style.getPropertyValue("--job-preview-lines"));
      setLimitExceeded(
        element.offsetHeight > limit * parseFloat(style.lineHeight) + 1 ? limit : undefined,
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  });

  const content = () => (
    <span
      ref={(element) => {
        text = element;
      }}
    >
      {props.text}
    </span>
  );
  return (
    <div class="preview">
      <Show
        when={props.prose}
        fallback={
          <pre
            id={id}
            class={["code", "text-preview", { wraps: !!props.wraps }]}
            tabindex="0"
            aria-label={props.label}
          >
            <code>{content()}</code>
          </pre>
        }
      >
        <p id={id} class="say text-preview">
          <span>{content()}</span>
        </p>
      </Show>
      <Show when={limitExceeded()} keyed>
        {(limit) => (
          <button
            type="button"
            aria-controls={id}
            aria-expanded={expanded() ? "true" : "false"}
            onClick={(event) => {
              const shortening = expanded();
              setExpanded(!shortening);
              if (shortening) {
                flush();
                event.currentTarget.scrollIntoView({ block: "nearest" });
              }
            }}
          >
            {expanded()
              ? "Show the first lines only"
              : lines() > limit
                ? `Show all ${formatCount(lines())} lines`
                : (props.wholeTextLabel ?? "Show the whole text")}
          </button>
        )}
      </Show>
    </div>
  );
}
