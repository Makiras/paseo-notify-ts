// Runs in a HOST-owned terminal, not a child of the plugin worker. Keep it
// self-contained: replacing/unloading the plugin must not kill the installer.
// Inputs are argv JSON, never interpolated into source or executed by a shell.
export const updateRunner = String.raw`
const { execFileSync } = require("node:child_process");
const input = JSON.parse(process.argv[1]);
const env = { ...process.env, PATH: input.path, PASEO_HOME: input.home };
delete env.PASEO_HOST;
const base = ["plugin", "update", "paseo-notifier", "--home", input.home,
  "--ref", input.commit, "--json"];
function run(extra) {
  return JSON.parse(execFileSync(input.cli, [...base, ...extra], {
    env, encoding: "utf8", timeout: 300000, maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"], shell: false,
  }));
}
function finish(code) {
  console.log("PASEO_NOTIFIER_UPDATE_DONE");
  process.exitCode = code;
  // Paseo removes a terminal when its process exits. Retain the result until
  // the user reads it; non-interactive test runs still exit normally.
  if (process.stdin.isTTY) {
    console.log("Press Enter to close this update terminal.");
    process.stdin.resume();
    process.stdin.once("data", () => process.exit(code));
  }
}
setTimeout(() => {
  try {
    console.log("Paseo Notifier: installing " + input.tag + " (" + input.commit + ")");
    const preview = run(["--check"]);
    const item = Array.isArray(preview) && preview.length === 1 && preview[0];
    if (!item || item.id !== "paseo-notifier" || item.outcome !== "update" ||
        item.current?.currentRevision !== input.expectedRevision ||
        JSON.stringify(item.current?.identity) !== JSON.stringify(input.identity) ||
        item.target?.kind !== "git" || item.target.commit !== input.commit) {
      throw new Error("The installation changed. Check again before retrying.");
    }
    const applied = run([]);
    if (!Array.isArray(applied) || applied.length !== 1 ||
        applied[0].id !== "paseo-notifier" || applied[0].outcome !== "updated") {
      throw new Error("Paseo did not confirm the update. Check plugin status and logs.");
    }
    console.log("UPDATE SUCCEEDED: " + input.tag + ". Reopen the plugin settings to verify the version.");
    finish(0);
  } catch {
    console.error("UPDATE FAILED OR UNCONFIRMED. Check Paseo Settings > Plugins and plugin logs before retrying.");
    finish(1);
  }
}, 1000);
`;
