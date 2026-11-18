import { logoDark, logoLight } from "../logo.ts";

/** The brand mark, drawn for the color scheme in force. `alt` names it where no words beside it do. */
export function BrandMark(props: { alt: string }) {
  return (
    <picture>
      <source srcset={logoDark} media="(prefers-color-scheme: dark)" />
      <img class="brand-mark" src={logoLight} alt={props.alt} width="28" height="28" />
    </picture>
  );
}
