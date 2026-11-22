import { announce } from "@ui-sdk/core";
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
  accessibleLabel?: string;
  /** A table button has no adjacent copyable text unless a clipboard write fails. */
  showTextOnFailure?: boolean;
  /**
   * In a list's row, beside a control that opens a confirmation: the result is said through UI SDK's
   * shared announcer rather than a live region of its own, which would keep the row's ancestors out of
   * what the open confirmation makes inert, and a row a read adds there pressable.
   */
  inRow?: boolean;
  buttonRef?: (button: HTMLButtonElement) => void;
}) {
  const [result, setResult] = createSignal<{ text: string; message: string; manual?: boolean }>();

  async function copy() {
    const text = props.text;
    try {
      // Absent outside a secure context, which the catch also takes.
      await navigator.clipboard.writeText(text);
      show({ text, message: "Copied." });
    } catch (error) {
      console.error(asError(error));
      show({
        text,
        manual: props.showTextOnFailure,
        message: "This browser did not allow copying here: select the text and copy it.",
      });
    }
  }

  function show(next: { text: string; message: string; manual?: boolean }) {
    setResult(next);
    if (props.inRow) announce(next.message);
  }

  return (
    <p class="copy">
      <button
        type="button"
        aria-label={props.accessibleLabel}
        ref={(element) => props.buttonRef?.(element)}
        onClick={() => void copy()}
      >
        {props.label}
      </button>
      {/* In the page from the start, so that a screen reader says what is written into it, unless
          the announcer says it instead. */}
      <span role={props.inRow ? undefined : "status"}>
        {result()?.text === props.text ? result()?.message : ""}
      </span>
      {result()?.text === props.text && result()?.manual && (
        <code class="command">{props.text}</code>
      )}
    </p>
  );
}
