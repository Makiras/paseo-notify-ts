import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const manifest = JSON.parse(await readFile("package.json", "utf8"));
const version = manifest.devDependencies["@getpaseo/plugin"];
if (!/^\d+\.\d+\.\d+$/.test(version))
  throw new Error("Pin the plugin SDK before preparing host checks");
const directory = resolve(".build/host");
await mkdir(directory, { recursive: true });
const metadata = JSON.parse(
  execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "pack",
      `@getpaseo/server@${version}`,
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      directory,
    ],
    { encoding: "utf8" },
  ),
)[0];
execFileSync("tar", [
  "-xzf",
  join(directory, metadata.filename),
  "-C",
  directory,
]);
// The extracted compiler resolves esbuild/TypeScript from this repository's
// locked development dependencies. No daemon, AI provider, or credentials run.
console.log(
  `Host compiler prepared: ${join(directory, "package/dist/server/server/plugins/compiler.js")}`,
);
