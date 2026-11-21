import { LABEL_KEY_PATTERN } from "contract";
import { For, Show, createSignal, flush } from "solid-js";

import { fieldText } from "../form.ts";
import { FieldGroup } from "./Field.tsx";

const keyName = (index: number) => `labels[${index}][key]`;
const valueName = (index: number) => `labels[${index}][value]`;

/**
 * The Labels `form`'s rows give, by key, or undefined for none, as the creation leaves them out; and
 * each row's value, as `formRefusal` takes its controls: a refusal of a Label is located by its
 * key, and a key the browser lets through, by the pattern, is refused only for its value's length.
 */
export function labelsOf(form: HTMLFormElement) {
  const data = new FormData(form);
  const labels: Record<string, string> = {};
  const controls: Record<string, string[]> = { labels: ["labels"] };
  for (let index = 0; data.has(keyName(index)); index += 1) {
    const key = fieldText(data, keyName(index));
    labels[key] = fieldText(data, valueName(index));
    controls[valueName(index)] = [`labels[${key}]`];
  }
  return { labels: Object.keys(labels).length ? labels : undefined, controls };
}

/**
 * The Labels of a creation, as rows of a key and a value. Labels are a record, so two rows with one
 * key cannot both be sent: the later one is refused by the browser's own validation, in the page's
 * words, as the hub never sees both.
 */
export function LabelFields(props: {
  hint: string;
  pending: boolean;
  refused: (name: string) => string | undefined;
  /** A row was added or removed. */
  onChange: () => void;
}) {
  let nextRow = 0;
  const [rows, setRows] = createSignal<readonly number[]>([]);
  let table: HTMLTableElement | undefined;
  let addButton: HTMLButtonElement | undefined;
  function markRepeatedKeys() {
    const seen = new Set<string>();
    for (const input of table?.querySelectorAll<HTMLInputElement>("input[data-label-key]") ?? []) {
      const repeated = input.value !== "" && seen.has(input.value);
      input.setCustomValidity(repeated ? "Another Label has this key" : "");
      seen.add(input.value);
    }
  }
  function add() {
    const row = nextRow++;
    setRows((previous) => [...previous, row]);
    props.onChange();
    flush();
    document.getElementById(`label-${row}-key`)?.focus();
  }
  function remove(row: number, button: HTMLButtonElement) {
    // Focus moves to the row that takes this one's place, or the one before, before this one goes.
    const line = button.closest("tr");
    const next = line?.nextElementSibling ?? line?.previousElementSibling;
    (next?.querySelector("button") ?? addButton)?.focus();
    setRows((previous) => previous.filter((other) => other !== row));
    props.onChange();
    flush();
    markRepeatedKeys();
  }
  return (
    <FieldGroup label="Labels" hint={props.hint} error={props.refused("labels")}>
      <Show when={rows().length}>
        <table
          class="records is-draft is-pairs"
          role="table"
          ref={(element) => {
            table = element;
          }}
          onInput={markRepeatedKeys}
        >
          <caption class="vh">Labels</caption>
          <thead role="rowgroup">
            <tr role="row">
              <th scope="col" role="columnheader" class="is-id">
                Key
              </th>
              <th scope="col" role="columnheader">
                Value
              </th>
              <th scope="col" role="columnheader" class="is-act">
                <span class="vh">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            <For each={rows()}>
              {(row, index) => {
                const error = () => props.refused(valueName(index()));
                return (
                  <tr role="row">
                    <td role="cell" class="is-id" data-l="Key">
                      <input
                        id={`label-${row}-key`}
                        name={keyName(index())}
                        aria-label={`Key of Label ${index() + 1}`}
                        class="mono"
                        required
                        pattern={LABEL_KEY_PATTERN.source}
                        title="A name of at most 63 letters, digits, -, _ and ., beginning and ending with a letter or digit, optionally behind a DNS subdomain and /"
                        spellcheck={false}
                        autocapitalize="off"
                        readonly={props.pending}
                        data-label-key
                      />
                    </td>
                    <td role="cell" data-l="Value">
                      <input
                        name={valueName(index())}
                        aria-label={`Value of Label ${index() + 1}`}
                        aria-invalid={error() ? "true" : undefined}
                        aria-describedby={error() ? `label-${row}-error` : undefined}
                        readonly={props.pending}
                      />
                      <Show when={error()}>
                        {(words) => (
                          <p class="field-error" id={`label-${row}-error`}>
                            <span class="mark mark-error" aria-hidden="true" />
                            <span>{words()}</span>
                          </p>
                        )}
                      </Show>
                    </td>
                    <td role="cell" class="is-act">
                      <button
                        type="button"
                        aria-label={`Remove Label ${index() + 1}`}
                        aria-disabled={props.pending ? "true" : undefined}
                        onClick={(event) => {
                          if (!props.pending) remove(row, event.currentTarget);
                        }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </Show>
      <div class="controls">
        <button
          type="button"
          ref={(element) => {
            addButton = element;
          }}
          aria-disabled={props.pending ? "true" : undefined}
          onClick={() => {
            if (!props.pending) add();
          }}
        >
          Add a Label
        </button>
      </div>
    </FieldGroup>
  );
}
