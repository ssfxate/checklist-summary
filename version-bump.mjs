import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const version = packageJson.version;

manifest.version = version;
const versions = existsSync("versions.json") ? JSON.parse(readFileSync("versions.json", "utf8")) : {};
versions[version] = manifest.minAppVersion;

writeFileSync("manifest.json", `${JSON.stringify(manifest, null, "\t")}\n`);
writeFileSync("versions.json", `${JSON.stringify(versions, null, "\t")}\n`);
execFileSync("git", ["add", "package.json", "package-lock.json", "manifest.json", "versions.json", "main.js", "styles.css"], { stdio: "inherit" });
