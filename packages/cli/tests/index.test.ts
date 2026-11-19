import { expect, test } from "vite-plus/test";

import { elflodgeCli } from "../src/index.ts";

// The snapshot pins the generated commands, flags and descriptions. trpc-cli renders examples
// in the help text and omits them from toJSON().
test("the commands and their flags", () => {
  expect(elflodgeCli("0.0.0").toJSON()).toMatchSnapshot();
});
