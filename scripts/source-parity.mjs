#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const roots = ["src/", "public/", "scripts/", "tests/", "deploy/",
  "engines/geo-evidence/", "engines/video-edit/", ".agents/"];
const sourceSuffix = /\.(?:mjs|cjs|mts|cts|tsx?|jsx?|sql|py|sh|css|html|swift|bat|m|applescript|toml|patch|ps1)$/i;
const thirdPartyResource = "engines/video-edit/apps/web/public/live2d/";
const packageFiles = /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json|Dockerfile)$/;
const runnablePolicy = /(?:^|\/)(?:pipelines|skills|contracts|guardrails|policies|migrations|connectors)\//;
const declarativeSuffix = /\.(?:ya?ml|json|md)$/i;
const distributionDescriptors = [
  /^engines\/video-edit\/bundles\/[^/]+\/bundle\.json$/,
  /^engines\/video-edit\/bundles\/ai-video\/library\//,
];
const textLauncher = /^engines\/video-edit\/apps\/desktop\/[^/]+\.app\/Contents\/MacOS\/[^/.]+$/;
const archivedOutput = /(?:^|\/)(?:outputs|var|dist|coverage|node_modules)\//;

export function isSharedSource(relativePath) {
  if (relativePath === "docs/video-manual-bridge.schema.json") return true;
  if (packageFiles.test(relativePath) && !archivedOutput.test(relativePath)) return true;
  if (!roots.some(root => relativePath.startsWith(root))) return false;
  if (relativePath.startsWith(thirdPartyResource) || archivedOutput.test(relativePath)) return false;
  if (distributionDescriptors.some(pattern => pattern.test(relativePath))) return false;
  return sourceSuffix.test(relativePath) || textLauncher.test(relativePath)
    || (runnablePolicy.test(relativePath) && declarativeSuffix.test(relativePath))
    || (/^\.agents\/skills\//.test(relativePath) && /\/SKILL\.md$/i.test(relativePath));
}

function tree(repository, ref) {
  const args = ["-C", repository, "ls-tree", "-r", "-z", "--full-tree", ref];
  const records = execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).split("\0");
  return new Map(records.filter(Boolean).flatMap(record => {
    const separator = record.indexOf("\t");
    const path = record.slice(separator + 1);
    const [mode, type, blob] = record.slice(0, separator).split(" ");
    return type === "blob" && isSharedSource(path) ? [[path, { mode, blob }]] : [];
  }));
}

function packageRuntimeConfiguration(directory, ref) {
  const manifest = JSON.parse(execFileSync("git", [
    "-C", directory, "show", ref + ":package.json",
  ], { encoding: "utf8" }));
  const fields = ["name", "type", "packageManager", "engines", "scripts", "dependencies", "devDependencies", "optionalDependencies", "pnpm"];
  return JSON.stringify(Object.fromEntries(fields.filter(field => Object.hasOwn(manifest, field))
    .map(field => [field, manifest[field]])));
}

export function compareSources(referenceDirectory, candidateDirectory, referenceRef = "HEAD", candidateRef = "HEAD") {
  const production = tree(resolve(referenceDirectory), referenceRef);
  const publicSource = tree(resolve(candidateDirectory), candidateRef);
  const productionOnly = [];
  const publicOnly = [];
  const changed = [];
  const metadataOnly = [];
  let identical = 0;
  for (const [path, reference] of production) {
    const candidate = publicSource.get(path);
    if (!candidate) productionOnly.push(path);
    else if (candidate.mode === reference.mode && candidate.blob === reference.blob) identical += 1;
    else if (path === "package.json" && candidate.mode === reference.mode &&
      packageRuntimeConfiguration(resolve(referenceDirectory), referenceRef)
      === packageRuntimeConfiguration(resolve(candidateDirectory), candidateRef)) metadataOnly.push(path);
    else changed.push(path);
  }
  for (const path of publicSource.keys()) if (!production.has(path)) publicOnly.push(path);
  return { identical, referencePaths: production.size, candidatePaths: publicSource.size,
    productionOnly, publicOnly, changed, metadataOnly };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [referenceDirectory, candidateDirectory, referenceRef = "HEAD", candidateRef = "HEAD", ...extra] = process.argv.slice(2);
  if (!referenceDirectory || !candidateDirectory || extra.length || [referenceRef, candidateRef].some(ref => ref.startsWith("-"))) {
    process.stderr.write("Usage: node scripts/source-parity.mjs <reference checkout> <candidate checkout> [reference-ref] [candidate-ref]\n");
    process.exitCode = 2;
  } else {
    const result = compareSources(referenceDirectory, candidateDirectory, referenceRef, candidateRef);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (result.productionOnly.length || result.publicOnly.length || result.changed.length) process.exitCode = 1;
  }
}
