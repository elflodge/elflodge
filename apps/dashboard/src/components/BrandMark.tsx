import { logoDark, logoLight } from "../logo.ts";

/**
 * The brand mark. Its ground is drawn in, so both are here and the stylesheet shows the one for the
 * theme in force. `alt` names it where no words beside it do.
 */
export function BrandMark(props: { alt: string }) {
  return (
    <>
      <img class="brand-mark only-light" src={logoLight} alt={props.alt} width="28" height="28" />
      <img class="brand-mark only-dark" src={logoDark} alt={props.alt} width="28" height="28" />
    </>
  );
}
