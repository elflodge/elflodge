import { mkdtempDisposable, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateLicenseFile } from "generate-license-file";
import pacote from "pacote";

const scalar = new URL("../node_modules/@scalar/api-reference/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", scalar), "utf8"));
const script = new URL(manifest.browser, scalar);
const { sources } = JSON.parse(await readFile(new URL(script.href + ".map"), "utf8"));

// The published script was bundled in Scalar's workspace. Its source map records the exact
// external packages used there, including versions outside the dashboard's dependency tree.
const dependencies = {
  [manifest.name]: manifest.version,
  "@scalar/icons": manifest.dependencies["@scalar/icons"],
  // Scalar compiles Phosphor's artwork into Vue wrappers. Only the wrappers appear in the map.
  // This is the artwork version in Scalar's build lockfile (scalar/scalar@7436196).
  "@phosphor-icons/core": "2.1.1",
};
for (const source of sources) {
  if (!source.includes("/node_modules/")) continue;
  const match = source.match(
    /\/\.pnpm\/[^/]+?@([^_/]+)(?:_[^/]*)?\/node_modules\/((?:@[^/]+\/)?[^/]+)\//,
  );
  if (!match) throw new Error(`Unrecognized Scalar source path: ${source}`);
  const [, version, name] = match;
  if (dependencies[name] && dependencies[name] !== version) {
    throw new Error(`Multiple versions of ${name} in the Scalar bundle`);
  }
  dependencies[name] = version;
}

// The generated CSS is embedded in the script before the mapped JavaScript modules.
const tailwind = (await readFile(script, "utf8")).match(/\/\*! tailwindcss v([\d.]+) \|/);
if (!tailwind) throw new Error("Missing Tailwind version in Scalar's CSS");
dependencies.tailwindcss = tailwind[1];

await using temp = await mkdtempDisposable(join(tmpdir(), "scalar-notices-"));
const input = join(temp.path, "package.json");
await writeFile(input, JSON.stringify({ private: true, dependencies }));
// Read each published archive without installing its transitive dependencies.
for (const [name, version] of Object.entries(dependencies)) {
  await pacote.extract(`${name}@${version}`, join(temp.path, "node_modules", name));
}

await generateLicenseFile(
  input,
  fileURLToPath(new URL("../scalar/THIRD_PARTY_NOTICES.txt", import.meta.url)),
  {
    // api-reference omits the monorepo's MIT text from its tarball. The bundled Scalar workspace
    // sources share this licence, published in the same release's sibling packages.
    replace: { [manifest.name]: join(temp.path, "node_modules/@scalar/icons/LICENSE") },
    lineEnding: "lf",
  },
);
