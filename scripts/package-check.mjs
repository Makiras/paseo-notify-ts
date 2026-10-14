import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

if (!process.env.PASEO_COMPILER_PATH)
  throw new Error("Set PASEO_COMPILER_PATH to the installed host compiler.js");
const { compilePlugin } = await import(
  pathToFileURL(process.env.PASEO_COMPILER_PATH).href
);
const directory = await mkdtemp(join(tmpdir(), "paseo-notifier-package-"));
try {
  const metadata = JSON.parse(
    execFileSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
      { encoding: "utf8" },
    ),
  )[0];
  execFileSync("tar", [
    "-xzf",
    join(directory, metadata.filename),
    "-C",
    directory,
  ]);
  const root = join(directory, "package");
  const result = await compilePlugin({
    client: join(root, "index.client.tsx"),
    server: join(root, "index.server.ts"),
  });
  assert.ok(result.clientBundle && result.serverBundle);
  assert.equal(await stat(join(root, "node_modules")).catch(() => null), null);
  console.log(
    `Packed plugin: ${metadata.entryCount} files, both entries accepted by the host without development dependencies.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
