import { Link } from "@tanstack/solid-router";
import { Show } from "solid-js";

import { listPages } from "../list-pages.ts";

export function RecordCrumbs(props: { to: keyof typeof listPages; batchId?: string }) {
  return (
    <nav class="crumbs" aria-label="Where this is">
      <ol>
        <li>
          {/* A prefix match would mark the parent list as the current page of this record. */}
          <Link class="stands-alone" to={props.to} activeOptions={{ exact: true }}>
            {listPages[props.to].title}
          </Link>
        </li>
        <Show when={props.batchId} keyed>
          {(id) => (
            <li>
              <span aria-hidden="true">/</span>
              <Link class="cut mono stands-alone" title={id} to="/batches/$id" params={{ id: id }}>
                {id}
              </Link>
            </li>
          )}
        </Show>
      </ol>
    </nav>
  );
}
