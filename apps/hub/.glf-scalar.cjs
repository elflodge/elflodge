const { findPackageJSON } = require("node:module");
const path = require("node:path");

module.exports = {
  inputs: ["../dashboard/package.json"],
  output: "./dist/scalar-notice.txt",
  // The hub ships Scalar's published standalone script.
  exclude: ["/^(?!@scalar/api-reference@)/"],
  // Scalar publishes its MIT text in its icons package and omits it from the reference tarball.
  replace: {
    "@scalar/api-reference": path.join(
      path.dirname(findPackageJSON("@scalar/icons", require.resolve("@scalar/api-reference"))),
      "LICENSE",
    ),
  },
};
