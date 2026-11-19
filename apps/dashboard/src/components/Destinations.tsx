import { Link, linkOptions, useLinkProps } from "@tanstack/solid-router";
import { Show } from "solid-js";

/**
 * The pages the bar leads to, in its order. A page the bar leads to adds its line here, checked by
 * the router as a link's options are. `activeOptions` says when the entry is the current
 * destination; by default, at its page and at every page under it.
 */
const DESTINATIONS = linkOptions([
  { to: "/jobs", label: "Jobs", activeOptions: { includeSearch: false } },
  { to: "/batches", label: "Batches", activeOptions: { includeSearch: false } },
  { to: "/runners", label: "Runners", activeOptions: { includeSearch: false } },
  { to: "/api-keys", label: "API keys", activeOptions: { includeSearch: false } },
  { to: "/organization", label: "Organization", activeOptions: { includeSearch: false } },
]);

/**
 * The bar's destinations as a list of links, the current one marked `aria-current="page"` by the
 * router.
 */
export function Destinations(props: { class: string }) {
  return (
    <ul class={props.class}>
      {DESTINATIONS.map(({ label, ...options }) => (
        <li>
          <Link {...options}>{label}</Link>
        </li>
      ))}
    </ul>
  );
}

/** The active link's label when the destinations have folded into the account menu. */
export function CurrentDestination() {
  return DESTINATIONS.map(({ label, ...options }) => {
    const link = useLinkProps(options);
    return (
      <Show when={link["aria-current"] === "page"}>
        <span class="here">{label}</span>
      </Show>
    );
  });
}
