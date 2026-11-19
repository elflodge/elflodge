import { Link, linkOptions } from "@tanstack/solid-router";

/**
 * The pages the bar leads to, in its order. A page the bar leads to adds its line here, checked by
 * the router as a link's options are. `activeOptions` says when the entry is the current
 * destination; by default, at its page and at every page under it.
 */
const DESTINATIONS = linkOptions([{ to: "/", label: "Home", activeOptions: { exact: true } }]);

/**
 * The bar's destinations as a list of links, the current one marked `aria-current="page"` by the
 * router. `onFollow` runs when one is followed.
 */
export function Destinations(props: { class: string; onFollow?: () => void }) {
  return (
    <ul class={props.class}>
      {DESTINATIONS.map(({ label, ...options }) => (
        <li>
          <Link {...options} onClick={() => props.onFollow?.()}>
            {label}
          </Link>
        </li>
      ))}
    </ul>
  );
}
