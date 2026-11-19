import { Link } from "@tanstack/solid-router";
import { Show } from "solid-js";

export function RecordCrumbs(props: { parent: "Jobs" | "Batches"; batchId?: string }) {
  return (
    <nav class="crumbs" aria-label="Where this is">
      <ol>
        <li>
          <Link class="stands-alone" to={props.parent === "Jobs" ? "/jobs" : "/batches"}>
            {props.parent}
          </Link>
        </li>
        <Show when={props.batchId}>
          {(id) => (
            <li>
              <span aria-hidden="true">/</span>
              <Link class="cut mono" title={id()} to="/batches/$id" params={{ id: id() }}>
                {id()}
              </Link>
            </li>
          )}
        </Show>
      </ol>
    </nav>
  );
}
