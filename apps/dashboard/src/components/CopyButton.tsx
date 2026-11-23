import { announce, prepareAnnouncements } from "@ui-sdk/core";
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
   * A row's Copy uses UI SDK's shared announcer so a live region in the row cannot leave new
   * controls pressable behind an open confirmation. Copy buttons in dialogs and Copy Output on
   * a job's page use an adjacent status.
   */
  sharedAnnouncer?: boolean;
  /** The ID of what the button's purpose depends on, such as a note that the text is shown once. */
  describedBy?: string;
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
    if (props.sharedAnnouncer) announce(next.message);
  }

  return (
    <p class="copy">
      <button
        type="button"
        aria-label={props.accessibleLabel}
        aria-describedby={props.describedBy}
        ref={(element) => {
          // Some screen readers announce only into a live region that was there before.
          if (props.sharedAnnouncer) prepareAnnouncements(element.ownerDocument);
          props.buttonRef?.(element);
        }}
        onClick={() => void copy()}
      >
        {props.label}
      </button>
      {/* In the page from the start, so that a screen reader says what is written into it, unless
          the announcer says it instead. */}
      <span class="copy-result" role={props.sharedAnnouncer ? undefined : "status"}>
        {result()?.text === props.text ? result()?.message : ""}
      </span>
      {result()?.text === props.text && result()?.manual && (
        <code class="command">{props.text}</code>
      )}
    </p>
  );
}
