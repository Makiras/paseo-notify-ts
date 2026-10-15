import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";

// Match the engine shipped with the pinned React Native SDK, rather than a
// newer desktop JS engine. Keep build output outside the installable plugin.
const tag = (
  await readFile("node_modules/react-native/sdks/.hermesversion", "utf8")
).trim();
const commit = tag.match(/-([a-f0-9]{40})$/)?.[1];
assert.ok(commit, "React Native must pin a Hermes commit");
const output = resolve(".build/hermes");
const source = resolve(".build/hermes-source-ci");
const build = resolve(".build/hermes-build-ci");
const executable = resolve(output, "hermes");
const stamp = `${commit}:intl:cstdint:v1\n`;
if ((await readFile(`${output}/revision`, "utf8").catch(() => "")) === stamp) {
  execFileSync(executable, ["-version"], { stdio: "ignore" });
  console.log(`Hermes ready (cached): ${commit}`);
  process.exit(0);
}
const run = (command, args) =>
  execFileSync(command, args, { stdio: "inherit" });
if (!(await stat(resolve(source, ".git")).catch(() => null)))
  run("git", [
    "clone",
    "--depth",
    "1",
    "--branch",
    tag,
    "https://github.com/facebook/hermes.git",
    source,
  ]);
assert.equal(
  execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  commit,
);
run("cmake", [
  "-S",
  source,
  "-B",
  build,
  "-G",
  "Ninja",
  "-DCMAKE_BUILD_TYPE=Release",
  "-DHERMES_BUILD_APPLE_FRAMEWORK=OFF",
  "-DHERMES_ENABLE_INTL=ON",
  "-DHERMES_ENABLE_DEBUGGER=OFF",
  "-DHERMES_ENABLE_TEST_SUITE=OFF",
  // The RN 0.81 engine omits this standard header in IntlUtils.cpp. New GCC
  // releases no longer include it transitively; this does not change JS behavior.
  "-DCMAKE_CXX_FLAGS=-include cstdint",
]);
run("cmake", [
  "--build",
  build,
  "--target",
  "hermes",
  "-j",
  String(Math.min(availableParallelism(), 8)),
]);
await mkdir(output, { recursive: true });
await copyFile(resolve(build, "bin/hermes"), executable);
await writeFile(`${output}/revision`, stamp);
console.log(`Hermes prepared: ${commit}`);
