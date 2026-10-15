import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import "./docs-check.mjs";

const base = "https://github.com/Makiras/paseo-notify-ts/wiki";
const source = "docs/wiki";
const files = (await readdir(source))
  .filter((name) => /^[A-Za-z0-9_-]+\.md$/.test(name))
  .sort();
const output = process.argv.indexOf("--output");
assert.ok(
  output === -1 || process.argv[output + 1],
  "--output requires a directory",
);
const temporary =
  output === -1 ? await mkdtemp(join(tmpdir(), "paseo-notifier-wiki-")) : null;
const directory = temporary
  ? join(temporary, "wiki")
  : resolve(process.argv[output + 1]);
const git = (args, cwd = directory) =>
  execFileSync(
    "git",
    [
      "-c",
      "credential.helper=",
      "-c",
      "credential.helper=!gh auth git-credential",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
try {
  if (temporary) {
    try {
      git(
        [
          "clone",
          "https://github.com/Makiras/paseo-notify-ts.wiki.git",
          directory,
        ],
        process.cwd(),
      );
    } catch {
      throw new Error(
        `Cannot clone the Wiki. Sign in with gh and create/save the initial Home page at ${base}, then retry. Source pages remain in docs/wiki/.`,
      );
    }
  } else await mkdir(directory, { recursive: true });
  const managed = ".paseo-notifier-pages.json";
  const previous = JSON.parse(
    await readFile(join(directory, managed), "utf8").catch(() => "[]"),
  );
  assert.ok(Array.isArray(previous), "Invalid managed-page manifest");
  for (const file of previous) {
    if (
      typeof file === "string" &&
      /^[A-Za-z0-9_-]+\.md$/.test(file) &&
      !files.includes(file)
    )
      await rm(join(directory, file), { force: true });
  }
  for (const file of files) {
    const content = await readFile(join(source, file), "utf8");
    const rendered = content.replace(
      /\]\(([A-Za-z0-9_-]+)\.md(#[^)]*)?\)/g,
      `](${base}/$1$2)`,
    );
    await writeFile(join(directory, file), rendered);
  }
  await writeFile(
    join(directory, managed),
    JSON.stringify(files, null, 2) + "\n",
  );
  if (temporary) {
    git([
      "add",
      "--",
      ...files,
      managed,
      ...previous.filter(
        (file) => /^[A-Za-z0-9_-]+\.md$/.test(file) && !files.includes(file),
      ),
    ]);
    if (!git(["diff", "--cached", "--name-only"]).trim())
      console.log("Wiki already matches source pages.");
    else {
      const name = git(["config", "user.name"], process.cwd()).trim();
      const email = git(["config", "user.email"], process.cwd()).trim();
      git([
        "-c",
        `user.name=${name}`,
        "-c",
        `user.email=${email}`,
        "commit",
        "-m",
        "Update Paseo Notifier documentation",
      ]);
      git(["push", "origin", "HEAD"]);
      console.log(`Published ${files.length} Wiki files: ${base}`);
    }
  } else console.log(`Preview written to ${directory}; no remote changes.`);
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
