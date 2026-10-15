import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  const paths = metadata.files.map((file) => file.path);
  assert.ok(paths.includes("LICENSE"));
  assert.ok(paths.includes("paseo-plugin.json"));
  assert.equal(
    paths.some((file) =>
      /(^|\/)(node_modules|\.git|\.state|dist|coverage|tests)(\/|$)|(^|\/)(\.env[^/]*|credentials\.json|operations\.json|owner\.lock|reap\.lock)$/.test(
        file,
      ),
    ),
    false,
  );
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
  if (process.argv.includes("--keep")) {
    const output = resolve("dist");
    await mkdir(output, { recursive: true });
    const archive = join(output, metadata.filename);
    await copyFile(join(directory, metadata.filename), archive);
    const hash = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
    await writeFile(`${archive}.sha256`, `${hash}  ${metadata.filename}\n`);
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    const manifest = JSON.parse(await readFile("paseo-plugin.json", "utf8"));
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    await writeFile(
      join(output, "release.json"),
      JSON.stringify(
        {
          schema: "paseo-notify-ts/release",
          version: pkg.version,
          tag: `v${pkg.version}`,
          commit,
          dirty: !!execFileSync(
            "git",
            ["status", "--porcelain", "--untracked-files=normal"],
            { encoding: "utf8" },
          ).trim(),
          paseo: manifest.requirements.paseo,
          archive: metadata.filename,
          sha256: hash,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`Install archive: ${archive}`);
  }
  console.log(
    `Packed plugin: ${metadata.entryCount} files, both entries accepted by the host without development dependencies.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
