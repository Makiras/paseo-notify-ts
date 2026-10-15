import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import "./version.mjs";

const tag = process.env.RELEASE_TAG;
assert.ok(tag, "RELEASE_TAG is required");
const repository = "Makiras/paseo-notify-ts";
const metadata = JSON.parse(await readFile("dist/release.json", "utf8"));
const head = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
assert.equal(
  metadata.commit,
  head,
  "Artifact commit differs from the checked-out tag",
);
assert.equal(metadata.tag, tag, "Artifact version differs from the release");
assert.equal(
  metadata.dirty,
  false,
  "Release artifacts must come from a clean checkout",
);
assert.equal(metadata.archive, `paseo-notify-ts-${metadata.version}.tgz`);
const archive = `dist/${metadata.archive}`;
const digest = createHash("sha256")
  .update(await readFile(archive))
  .digest("hex");
assert.equal(metadata.sha256, digest, "Artifact checksum mismatch");
assert.equal(
  await readFile(`${archive}.sha256`, "utf8"),
  `${digest}  ${metadata.archive}\n`,
);
const gh = (args) =>
  execFileSync("gh", [...args, "--repo", repository], { encoding: "utf8" });
let existing;
try {
  existing = JSON.parse(gh(["release", "view", tag, "--json", "isDraft"]));
} catch {
  /* Creating a release below also fails if authentication/network is unavailable. */
}
assert.ok(
  !existing || existing.isDraft,
  "A published release is immutable; use a new version",
);
if (!existing)
  gh([
    "release",
    "create",
    tag,
    "--verify-tag",
    "--draft",
    "--title",
    tag,
    "--generate-notes",
  ]);
gh([
  "release",
  "upload",
  tag,
  archive,
  `${archive}.sha256`,
  "dist/release.json",
  "--clobber",
]);
gh(["release", "edit", tag, "--draft=false", "--latest"]);
console.log(`Published https://github.com/${repository}/releases/tag/${tag}`);
