import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });
const output = (command, args) => execFileSync(command, args, { encoding: "utf8" }).trim();
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));

if (packageJson.version !== manifest.version) throw new Error("package.json and manifest.json versions differ");
const branch = output("git", ["branch", "--show-current"]);
if (!branch) throw new Error("Cannot release from a detached HEAD");

run("git", ["push", "origin", branch, "--follow-tags"]);
run("gh", ["release", "create", packageJson.version, "main.js", "manifest.json", "styles.css", "--verify-tag", "--generate-notes", "--title", packageJson.version]);
