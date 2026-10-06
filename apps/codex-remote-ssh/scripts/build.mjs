import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { build } from "esbuild";

const outputRoot = path.resolve("dist");
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const app = await build({
  bundle: true,
  entryPoints: ["src/app/index.tsx"],
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  write: false,
  outdir: "out",
});
const javascript = app.outputFiles.find((file) => file.path.endsWith(".js"));
const css = app.outputFiles.find((file) => file.path.endsWith(".css"));
if (!javascript) throw new Error("App build did not produce JavaScript");
const template = await readFile("src/app/index.html", "utf8");
const html = template
  .replace("<!-- APP_STYLE -->", () => css?.text ?? "")
  .replace("<!-- APP_SCRIPT -->", () => `<script>${javascript.text.replace(/<\/script/gi, "<\\/script")}</script>`);

await Promise.all([
  writeFile(path.join(outputRoot, "app.html"), html),
  build({
    bundle: true,
    entryPoints: ["src/server/index.ts"],
    external: ["node-pty"],
    format: "esm",
    platform: "node",
    target: "node22",
    outfile: path.join(outputRoot, "server.js"),
  }),
]);

await writeFile(
  ".mcp.json",
  `${JSON.stringify({
    mcpServers: {
      "remote-ssh": {
        command: "node",
        args: ["./dist/server.js"],
        cwd: ".",
      },
    },
  }, null, 2)}\n`,
  "utf8",
);
