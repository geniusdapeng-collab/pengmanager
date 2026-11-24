import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const testDirectory = join(root, "tests");
const publicTests = [
  "adapters.test.mjs",
  "admin-auth.test.mjs",
  "agent.test.mjs",
  "ai-approval-worker-client.test.mjs",
  "ai-approval.test.mjs",
  "application-lifecycle.test.mjs",
  "content-intent-regression.test.mjs",
  "content-intent.test.mjs",
  "model-routing.test.mjs",
  "policy.test.mjs",
  "product-naming.test.mjs",
  "public-release.test.mjs",
  "publication-view.test.mjs",
  "state-json.test.mjs",
  "state-machine.test.mjs",
  "store.test.mjs",
  "video-runtime-snapshot.test.mjs",
  "workloom-launch.test.mjs",
];

const available = readdirSync(testDirectory)
  .filter(name => name.endsWith(".test.mjs"))
  .sort();
const missing = publicTests.filter(name => !available.includes(name));
if (missing.length) {
  console.error("The public test profile is incomplete:", missing.join(", "));
  process.exitCode = 1;
} else {
  const outsideProfile = available.filter(name => !publicTests.includes(name));
  console.log(JSON.stringify({
    profile: "public",
    selected: publicTests,
    outsideProfile,
    detail: "Additional suites may need production-profile fixtures, native assets or platform dependencies.",
  }, null, 2));
  const result = spawnSync(process.execPath, [
    "--test", ...publicTests.map(name => join(testDirectory, name)),
  ], { cwd: root, stdio: "inherit" });
  if (result.error) console.error("Failed to start the public test profile:", result.error.message);
  if (result.signal) console.error("Public test profile stopped by signal:", result.signal);
  process.exitCode = result.status ?? 1;
}
