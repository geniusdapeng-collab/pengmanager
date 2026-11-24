import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const [privatePath, publicPath] = process.argv.slice(2);
if (!privatePath || !publicPath || process.argv.length !== 4) {
  throw new Error('Usage: node build-public-video.mjs <pinned-private-root> <staged-public-root>');
}
const privateRoot = fs.realpathSync(privatePath);
const publicRoot = fs.realpathSync(publicPath);
const upstreamRoot = path.join(publicRoot, 'upstreams');
const enginePath = 'engines/video-edit';
const engineRoot = path.join(publicRoot, enginePath);
const sourceSnapshotPath = 'upstreams/workloom-video-edit.snapshot.json';
const sourcePinPath = 'upstreams/workloom-video-edit.pin.json';
const bundleId = 'ai-video';
const snapshotBytes = fs.readFileSync(path.join(privateRoot, sourceSnapshotPath));
const snapshot = JSON.parse(snapshotBytes);
const privatePin = JSON.parse(fs.readFileSync(path.join(privateRoot, sourcePinPath)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

assert.notEqual(privateRoot, publicRoot);
assert.equal(fs.realpathSync(engineRoot), engineRoot);
assert(!publicRoot.startsWith(privateRoot + path.sep) && !privateRoot.startsWith(publicRoot + path.sep));
assert.equal(sha(snapshotBytes), privatePin.snapshotSha256);
assert.equal(snapshot.schemaVersion, 'pengmanager.edit-snapshot/v1');
assert.equal(snapshot.source.commit, privatePin.commit);
assert.equal(snapshot.files.length, snapshot.sourceFileCount);
assert.equal(snapshot.sourceFileCount, privatePin.sourceFileCount);
assert.equal(snapshot.targetOwnedFiles.length, snapshot.targetOwnedFileCount);
const sourceRows = new Map(snapshot.files.map(row => [row.path, row]));
const hostRows = new Map(snapshot.targetOwnedFiles.map(row => [row.path, row]));
assert.equal(new Set([...sourceRows.keys(), ...hostRows.keys()]).size, sourceRows.size + hostRows.size);

function ordinary(relative, root) {
  assert(!path.isAbsolute(relative) && !relative.includes('\\') && path.posix.normalize(relative) === relative);
  assert(!relative.split('/').some(part => !part || part === '.' || part === '..'));
  const absolute = path.join(root, relative);
  try {
    const stat = fs.lstatSync(absolute);
    assert(stat.isFile() && !stat.isSymbolicLink() && fs.realpathSync(absolute) === absolute,
      `Unexpected linked or non-regular path: ${relative}`);
    return absolute;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function writeJson(absolute, document) {
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  if (fs.existsSync(absolute) && fs.readFileSync(absolute).equals(bytes)) return bytes;
  fs.writeFileSync(absolute, bytes);
  return bytes;
}

const bundleRelative = 'bundles/ai-video/bundle.json';
const originalBundleBytes = fs.readFileSync(path.join(privateRoot, enginePath, bundleRelative));
assert.equal(sha(originalBundleBytes), sourceRows.get(bundleRelative)?.targetSha256);
const bundle = JSON.parse(originalBundleBytes);
assert.equal(bundle.workloom.industry, bundleId);
assert.notEqual(bundle.workloom.status, 'stable', 'Production-signed bundle projection needs a separate official grant');
const bundleRoot = path.join(engineRoot, 'bundles', bundleId);
const { localBundleDigest, loadVerifiedBundleManifest } = await import(pathToFileURL(path.join(
  engineRoot, 'packages/video-studio/src/local-bundle.ts',
)).href);
assert.equal(localBundleDigest(bundle), bundle.integrity.digest, 'Existing bundle must verify before projection');
const omittedBundleAssets = {};
const selectedBundleAssets = {};
for (const [group, declared] of Object.entries(bundle.workloom.provides)) {
  const assetPaths = Array.isArray(declared) ? declared : [declared];
  const kept = [];
  for (const asset of assetPaths) {
    assert.equal(typeof asset, 'string', `Unsupported bundle group ${group}`);
    const file = ordinary(asset, bundleRoot);
    if (!file) {
      assert.equal(group, 'library', `Release is missing a required ${group} member: ${asset}`);
      omittedBundleAssets[group] = (omittedBundleAssets[group] ?? 0) + 1;
      continue;
    }
    assert(!Object.hasOwn(selectedBundleAssets, asset), `Duplicate bundle path: ${asset}`);
    assert(/^[a-f0-9]{64}$/.test(bundle.integrity.assets[asset] ?? ''), `Unreviewed bundle path: ${asset}`);
    kept.push(asset);
    selectedBundleAssets[asset] = sha(fs.readFileSync(file));
  }
  bundle.workloom.provides[group] = Array.isArray(declared) ? kept : kept[0];
}
bundle.integrity = { algorithm: 'sha256', digest: '0'.repeat(64), assets: selectedBundleAssets };
bundle.integrity.digest = localBundleDigest(bundle);
writeJson(path.join(engineRoot, bundleRelative), bundle);
assert.equal(loadVerifiedBundleManifest(bundleId, path.join(engineRoot, 'bundles')).integrity.digest, bundle.integrity.digest);

function filesUnder(root, relative = '') {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const file = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return filesUnder(root, file);
    assert(entry.isFile(), `Unexpected engine path type: ${file}`);
    return [file];
  });
}

const publicPaths = filesUnder(engineRoot).sort();
const projectedComparedToPrivate = [];
const publicSource = [];
const publicHost = [];
for (const file of publicPaths) {
  const source = sourceRows.get(file);
  const baseline = source ?? hostRows.get(file);
  if (!baseline) throw new Error(`An embedded file falls outside the reviewed private inventory: ${file}`);
  const absolute = ordinary(file, engineRoot);
  const bytes = fs.readFileSync(absolute);
  const targetSha256 = sha(bytes);
  if (targetSha256 !== baseline.targetSha256) projectedComparedToPrivate.push(file);
  const row = { path: file, mode: baseline.mode, targetSha256 };
  (source ? publicSource : publicHost).push(row);
}
const selected = {
  schemaVersion: 'pengmanager.edit-snapshot/public-v1',
  source: { commit: privatePin.commit },
  sourceFileCount: privatePin.sourceFileCount,
  omittedSourceFileCount: privatePin.sourceFileCount - publicSource.length,
  files: publicSource,
  targetOwnedFiles: publicHost,
};
fs.mkdirSync(upstreamRoot, { recursive: true });
const projectionBytes = writeJson(path.join(publicRoot, sourceSnapshotPath), selected);
const publicPin = {
  repository: privatePin.repository,
  commit: privatePin.commit,
  tree: privatePin.tree,
  engineRoot: privatePin.engineRoot,
  sourceFileCount: privatePin.sourceFileCount,
  distribution: 'public-source',
  snapshot: sourceSnapshotPath,
  snapshotSha256: sha(projectionBytes),
  capabilityCatalog: privatePin.capabilityCatalog,
};
writeJson(path.join(publicRoot, sourcePinPath), publicPin);
writeJson(path.join(upstreamRoot, 'video-edit-local-assets.json'), {
  schemaVersion: 'pengmanager.video-local-assets/v1',
  sourceRepository: 'geniusdapeng-collab/WorkLoom-video-edit',
  sourceCommit: privatePin.commit,
  scope: 'public-embedded-asset-integrity',
  workloomActivationGranted: false,
  assetCount: Object.keys(selectedBundleAssets).length,
  digest: bundle.integrity.digest,
  omittedAssetCountsByGroup: omittedBundleAssets,
});
console.log(JSON.stringify({
  upstreamSourceFiles: privatePin.sourceFileCount,
  publicSourceFiles: publicSource.length,
  publicHostFiles: publicHost.length,
  totalPublicEngineFiles: publicPaths.length,
  projectedComparedToPrivate,
  publicBundleDigest: bundle.integrity.digest,
  publicBundleAssets: Object.keys(selectedBundleAssets).length,
  omittedAssetCountsByGroup: omittedBundleAssets,
  snapshotSha256: publicPin.snapshotSha256,
}, null, 2));
