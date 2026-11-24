import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pin = JSON.parse(readFileSync(join(root, "upstreams/workloom-video-edit.pin.json"), "utf8"));
const publicSource = pin.distribution === "public-source";
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--engines")) {
  console.error("Usage: node scripts/test-source-profile.mjs [--engines]");
  process.exit(2);
}
function suites(relativeDirectory) {
  return readdirSync(join(root, relativeDirectory))
    .filter(name => name.endsWith(".test.mjs"))
    .sort().map(name => join(relativeDirectory, name));
}
let testArgs;
if (args[0] === "--engines") {
  testArgs = ["--test", ...suites("engines/geo-evidence/test"),
    ...(publicSource ? [] : ["tests/integrated-engines.test.mjs"])];
} else if (publicSource) {
  testArgs = ["scripts/test-public-profile.mjs"];
} else {
  testArgs = ["--test", ...suites("tests")];
}
const result = spawnSync(process.execPath, testArgs, { cwd: root, stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
