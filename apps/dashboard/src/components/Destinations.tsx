import { Link } from "@tanstack/solid-router";
import type { ActiveOptions } from "@tanstack/solid-router";

import type { FileRouteTypes } from "../routeTree.gen.ts";

/**
 * The pages the bar leads to, in its order. A page the bar leads to adds its line here.
 * `activeOptions` says when the entry is the current destination; by default, at its page and at
 * every page under it.
 */
const DESTINATIONS: readonly {
  to: FileRouteTypes["to"];
  name: string;
  activeOptions?: ActiveOptions;
}[] = [{ to: "/", name: "Home", activeOptions: { exact: true } }];

/**
 * The bar's destinations as a list of links, the current one marked `aria-current="page"` by the
 * router. `onFollow` runs when one is followed.
 */
export function Destinations(props: { class: string; onFollow?: () => void }) {
  return (
    <ul class={props.class}>
      {DESTINATIONS.map((destination) => (
        <li>
          <Link
            to={destination.to}
            activeOptions={destination.activeOptions}
            onClick={() => props.onFollow?.()}
          >
            {destination.name}
          </Link>
        </li>
      ))}
    </ul>
  );
}
