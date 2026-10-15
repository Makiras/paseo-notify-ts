import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const directory = "docs/wiki";
const pages = (await readdir(directory)).filter((name) => name.endsWith(".md"));
const sidebar = await readFile(join(directory, "_Sidebar.md"), "utf8");
for (const file of [
  "README.md",
  "OVERVIEW.md",
  ...pages.map((page) => join(directory, page)),
]) {
  const content = await readFile(file, "utf8");
  if (file.startsWith(directory) && !file.includes("/_")) {
    assert.equal(
      [...content.matchAll(/^# .+$/gm)].length,
      1,
      `${file}: expected one page title`,
    );
    assert.ok(
      sidebar.includes(`(${file.slice(directory.length + 1)})`),
      `${file}: missing from sidebar`,
    );
  }
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    const path = resolve(dirname(file), decodeURIComponent(target));
    assert.ok(
      path.startsWith(process.cwd() + "/"),
      `${file}: link escapes repository`,
    );
    assert.ok(
      await stat(path).catch(() => null),
      `${file}: missing link ${target}`,
    );
  }
}
console.log(
  `Documentation verified: ${pages.filter((name) => !name.startsWith("_")).length} pages, sidebar, README and overview links.`,
);
