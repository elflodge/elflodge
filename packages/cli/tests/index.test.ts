import { expect, test } from "vite-plus/test";

import { elflodgeCli } from "../src/index.ts";

// The snapshot pins the generated commands, flags and descriptions so changes from a contract edit
// or trpc-cli upgrade show up here. trpc-cli renders examples in help and omits them from toJSON().
test("the commands and their flags", () => {
  expect(elflodgeCli("0.0.0").toJSON()).toMatchSnapshot();
});
