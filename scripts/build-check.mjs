import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
await mkdir(".build", { recursive: true });
const hostModules = [
  "@getpaseo/plugin",
  "@getpaseo/plugin/*",
  "zod",
  "react",
  "react/jsx-runtime",
  "react-native",
  "@tanstack/react-query",
];
for (const target of ["client", "server"]) {
  const result = await build({
    entryPoints: [target === "client" ? "index.client.tsx" : "index.server.ts"],
    bundle: true,
    write: false,
    platform: target === "server" ? "node" : "browser",
    format: "cjs",
    target: "es2022",
    external: hostModules,
    metafile: true,
    jsx: "automatic",
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    const path = relative(root, resolve(input));
    if (path.startsWith(target === "client" ? "server/" : "client/"))
      throw new Error(`Runtime boundary violated: ${path}`);
  }
  await writeFile(`.build/${target}.cjs`, result.outputFiles[0].text);
  console.log(`${target}: ${result.outputFiles[0].contents.length} bytes`);
}
// Optional: verify with the exact installed host compiler, without starting a daemon.
if (process.env.PASEO_COMPILER_PATH) {
  const { compilePlugin } = await import(
    pathToFileURL(process.env.PASEO_COMPILER_PATH).href
  );
  const result = await compilePlugin({
    client: resolve("index.client.tsx"),
    server: resolve("index.server.ts"),
  });
  await writeFile(".build/host-client.js", result.clientBundle);
  await writeFile(".build/host-server.js", result.serverBundle);
  console.log("Paseo host compiler: both runtime entries accepted");
}
