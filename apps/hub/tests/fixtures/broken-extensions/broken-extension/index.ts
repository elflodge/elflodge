// An extension that bundles but fails as it loads, as one whose setup needs what the host lacks.
export default function extension() {
  throw new Error("This extension needs a setting it does not have.");
}
