import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const pkg = await readJson("package.json");
const lock = await readJson("package-lock.json");
const stable = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
let source = await readFile("shared/version.ts", "utf8");
if (process.argv[2] === "set") {
  const version = process.argv[3];
  assert.ok(
    stable.test(version ?? ""),
    "Pass a stable version, e.g. npm run version:set -- 0.2.1",
  );
  pkg.version = lock.version = lock.packages[""].version = version;
  source = source.replace(
    /export const pluginVersion = "[^"]+";/,
    `export const pluginVersion = "${version}";`,
  );
  await writeFile("package.json", JSON.stringify(pkg, null, 2) + "\n");
  await writeFile("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
  await writeFile("shared/version.ts", source);
}
assert.ok(
  stable.test(pkg.version),
  "The package version must be a stable semantic version",
);
assert.equal(lock.version, pkg.version, "Lockfile version differs");
assert.equal(
  lock.packages[""].version,
  pkg.version,
  "Lockfile root version differs",
);
assert.equal(
  source.match(/export const pluginVersion = "([^"]+)";/)?.[1],
  pkg.version,
  "UI/runtime version differs",
);
const tag = process.env.RELEASE_TAG;
if (tag)
  assert.equal(tag, `v${pkg.version}`, "Release tag must match package.json");
console.log(`Version verified: ${pkg.version}${tag ? ` (${tag})` : ""}`);
