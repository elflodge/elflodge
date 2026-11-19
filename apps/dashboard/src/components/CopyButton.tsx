import { asError } from "contract";
import { createSignal } from "solid-js";

/**
 * A button that copies `text`, such as a command or a key shown beside it, then says it did. Where
 * the browser does not allow it, as on a page served over plain HTTP from another machine, it says
 * to select the text and copy it, which the text beside it allows.
 */
export function CopyButton(props: {
  text: string;
  label: string;
  buttonRef?: (button: HTMLButtonElement) => void;
}) {
  const [result, setResult] = createSignal<"copied" | "refused">();

  async function copy() {
    try {
      // Absent outside a secure context, which the catch also takes.
      await navigator.clipboard.writeText(props.text);
      setResult("copied");
    } catch (error) {
      console.error(asError(error));
      setResult("refused");
    }
  }

  return (
    <p class="copy">
      <button
        type="button"
        ref={(element) => props.buttonRef?.(element)}
        onClick={() => void copy()}
      >
        {props.label}
      </button>
      {/* In the page from the start, so that a screen reader says what is written into it. */}
      <span role="status">
        {result() === "copied"
          ? "Copied."
          : result() === "refused"
            ? "This browser did not allow copying here: select the text and copy it."
            : ""}
      </span>
    </p>
  );
}
