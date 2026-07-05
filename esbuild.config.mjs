import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "@codemirror/view", "@codemirror/state"],
  format: "cjs",
  platform: "node",
  target: "es2022",
  outfile: "main.js",
  logLevel: "info"
});
