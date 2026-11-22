import type { ToolCalls } from "contract";
import { For, Show } from "solid-js";

import { formatCount } from "../format.ts";

/**
 * A job's or a Batch's tool calls by tool name, in a disclosure closed until opened, with nothing
 * shown before any call.
 */
export function ToolCallsLedger(props: { calls: ToolCalls | undefined }) {
  // By name, so rows keep their places as counts grow between reads.
  const names = () => Object.keys(props.calls ?? {}).toSorted();
  // Neither Show is keyed and each count is read from the map, so a read with new counts keeps the
  // same `details`, and it stays open.
  return (
    <Show when={names().length > 0}>
      <details>
        <summary>Show tool calls</summary>
        <table class="ledger">
          <caption class="vh">Tool calls by tool</caption>
          <thead>
            <tr>
              <th scope="col">Tool</th>
              <th scope="col" class="num">
                Calls
              </th>
            </tr>
          </thead>
          <tbody>
            <For each={names()}>
              {(name) => (
                <tr>
                  <th scope="row">
                    <code>{name}</code>
                  </th>
                  <td class="num">{formatCount(props.calls?.[name] ?? 0)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <p class="note">These are calls: one web search call can run several searches.</p>
      </details>
    </Show>
  );
}
