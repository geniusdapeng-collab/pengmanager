import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApiError } from "../src/domain/errors.mjs";
import { articleTakeoverFingerprint, assertArticleTakeoverParity } from "../src/domain/article-takeover.mjs";
import { hashObject, hashText } from "../src/domain/hash.mjs";
import { createPublicArticleOverlay } from "../src/http/article-overlay.mjs";
import { createGeoOsServer } from "../src/http/server.mjs";
import { buildArticleTakeoverBatch, prepareArticleTakeoverBatch } from "../scripts/prepare-article-takeover-batch.mjs";

const slug = "existing-article";
const canonicalPath = `/zh/articles/${slug}`;
const detailsPath = `/public-api/content/zh-CN/article/${slug}`;
const publicOrigin = "https://pengmanager.example";
const baseReleaseId = "REL-00001";
const baseSnapshotHash = "a".repeat(64);
const updatedAt = "2026-11-28T00:00:00.000Z";
const rawPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=", "base64");
const sha256 = createHash("sha256").update(rawPng).digest("hex");
const mediaPath = `/public-media/overlay-${sha256}/${sha256}`;
const cmsAssetId = "MED-" + "3".repeat(32);
const original = {
  id: baseReleaseId, releaseId: baseReleaseId, locale: "zh-CN", format: "article",
  canonicalPath, canonicalUrl: publicOrigin + canonicalPath, snapshotHash: baseSnapshotHash,
  title: "原来公开的文章", summary: "旧摘要", body: "旧正文",
  blocks: [{ type: "paragraph", text: "旧正文" }], assets: [],
  sources: [{ label: "旧稿的公开资料", url: "https://reference.example/" }],
  alternates: { "zh-CN": publicOrigin + canonicalPath }, translationStatus: "original",
  publishedAt: "2026-11-18T00:00:00.000Z", updatedAt: "2026-11-18T01:00:00.000Z",
  etag: '"original"',
};
const other = { ...original, id: "REL-00002", releaseId: "REL-00002", canonicalPath: "/zh/articles/other",
  canonicalUrl: publicOrigin + "/zh/articles/other", title: "另一篇公开文章", snapshotHash: "b".repeat(64) };
const en = { ...original, id: "REL-00003", releaseId: "REL-00003", locale: "en-US", canonicalPath: "/en/articles/existing-article",
  canonicalUrl: publicOrigin + "/en/articles/existing-article", title: "Published English article" };
const article = {
  canonicalPath, baseReleaseId, baseSnapshotHash, title: "改写后的公开文章", summary: "新版摘要",
  body: "第一段有 <例子>。\n\n第二段。",
  blocks: [{ type: "paragraph", text: "第一段有 <例子>。" }, { type: "paragraph", text: "第二段。" }],
  assets: [{ sha256, width: 1, height: 1, size: rawPng.length, alt: "图片的替代文字", caption: "图片的说明", afterBlockIndex: 0 }],
};

async function fixture(t, { manifest = true, rows = [article], external = false, legacyAlias = false } = {}) {
  const temp = await mkdtemp(join(tmpdir(), "pengmanager-article-overlay-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const publicDir = join(temp, "public");
  const overlayDir = join(temp, external ? "external-bundle" : "publication-overlay");
  await mkdir(publicDir);
  await cp(new URL("../public/site.html", import.meta.url), join(publicDir, "site.html"));
  const file = join(overlayDir, "media", `${sha256}.png`);
  const cmsFile = join(temp, "native-media.bin");
  await writeFile(cmsFile, rawPng);
  if (manifest) {
    await mkdir(join(overlayDir, "media"), { recursive: true });
    await writeFile(file, rawPng);
    await writeFile(join(overlayDir, "articles.json"), JSON.stringify({ schema: "pengmanager.public-article-overlay/v1",
      updatedAt, articles: rows }));
  }
  let active = original;
  let alias = null;
  let cmsReader = () => null;
  const editorial = {
    publicOrigin,
    publicDetail({ locale, format, slug: received }) {
      if (locale === "en-US" && received === slug && format === "article") return en;
      if (locale === "zh-CN" && received === "other" && format === "article") return other;
      if (locale !== "zh-CN" || received !== slug || format !== "article") {
        throw new ApiError(404, "PUBLIC_CONTENT_NOT_FOUND", "内容不存在。");
      }
      if (!active) throw new ApiError(410, "PUBLIC_CONTENT_UNAVAILABLE", "内容不可用。");
      return active;
    },
    publicList({ locale, limit, cursor }) {
      const all = locale === "en-US" ? [en] : [active, other].filter(Boolean);
      const selected = cursor ? all.slice(1) : all;
      const items = selected.slice(0, limit).map(({ body: _body, blocks: _blocks, ...card }) => card);
      return { items, total: all.length, nextCursor: selected.length > limit ? "authentic-next-cursor" : null };
    },
    previewRelease() {
      return { ...original, title: "独立私有预览", body: "不进入公开页面的预览正文", preview: true };
    },
  };
  if (legacyAlias) editorial.publicArticleMediaAlias = () => alias;
  const auth = {
    validateRequestSource() {},
    requireAccess(request) {
      if (request.headers["x-fixture-auth"] === "preview") return { actor: "fixture", method: "administrator" };
      throw new ApiError(401, "AUTH_REQUIRED", "需要身份。");
    },
  };
  const mediaReads = [];
  const mediaAssets = {
    async openVerifiedAsset(assetId, options) {
      mediaReads.push({ assetId, options });
      if (assetId === cmsAssetId) {
        const opened = await cmsReader();
        if (opened) return { asset: { mime: "image/png", size: rawPng.length, sha256 }, handle: opened };
      }
      throw new ApiError(404, "ORIGINAL_MEDIA_NOT_FOUND", "原素材不存在。");
    },
  };
  return { publicDir, overlayDir, file, cmsFile, editorial, auth, mediaAssets, mediaReads,
    ...(external ? { articleOverlayDirectory: overlayDir } : {}),
    setActive(value) { active = value; },
    setAlias(value) { alias = value; },
    setCmsReader(read) { cmsReader = read; },
  };
}

function nativeRevision(detail) {
  const releaseId = "REL-00012";
  return { ...detail, releaseId, id: releaseId, snapshotHash: "c".repeat(64),
    updatedAt: "2026-11-28T03:00:00.000Z", etag: '"changed"',
    assets: detail.assets.map(asset => ({ ...asset, id: cmsAssetId, assetId: cmsAssetId, url: `/public-media/${cmsAssetId}/${sha256}` })),
    blocks: detail.blocks.map(block => block.type === "image" ? { ...block, assetId: cmsAssetId } : block),
  };
}

async function listen(t, fixture) {
  const articleOverlay = createPublicArticleOverlay(fixture);
  const server = createGeoOsServer({ ...fixture, articleOverlay, publicWebsite: true, service: { publicPreview: () => ({}) } });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return (path, options) => fetch(origin + path, { ...options, redirect: "manual" });
}

function siteData(html) {
  return JSON.parse(/<script id="site-data" type="application\/json">([^<]*)<\/script>/u.exec(html)[1]);
}

test("SSR, embedded page seed, anonymous detail and public listing share the same replacement", async t => {
  const fixtureData = await fixture(t);
  const request = await listen(t, fixtureData);
  const response = await request(detailsPath);
  assert.equal(response.status, 200);
  const detail = await response.json();
  assert.equal(detail.body, article.body);
  assert.equal(detail.summary, article.summary);
  assert.equal(detail.id, baseReleaseId);
  assert.equal(detail.releaseId, baseReleaseId);
  assert.equal(detail.updatedAt, updatedAt);
  assert.equal(detail.publishedAt, original.publishedAt);
  assert.equal(detail.canonicalUrl, original.canonicalUrl);
  assert.deepEqual(detail.sources, original.sources);
  assert.equal(detail.assets[0].url, mediaPath);
  assert.deepEqual(detail.blocks.map(item => item.type), ["paragraph", "image", "paragraph"]);
  const { etag, ...etagContent } = detail;
  assert.equal(etag, `"${hashObject(etagContent)}"`);
  assert.equal(response.headers.get("etag"), etag);
  assert.notEqual(detail.snapshotHash, original.snapshotHash);

  const html = await request(canonicalPath).then(value => value.text());
  assert.match(html, /<h1>改写后的公开文章<\/h1>/u);
  assert.match(html, /第一段有 &lt;例子&gt;。/u);
  assert.ok(html.includes(`<link rel="canonical" href="${detail.canonicalUrl}"`));
  assert.ok(html.includes(mediaPath));
  assert.deepEqual(siteData(html).detail, detail);
  const archive = await request("/zh/articles").then(value => value.text());
  assert.match(archive, /改写后的公开文章/u);
  const home = await request("/").then(value => value.text());
  assert.match(home, /改写后的公开文章/u);

  const listingPath = "/public-api/content?locale=zh-CN&format=article&limit=1";
  const page = await request(listingPath).then(value => value.json());
  const { body: _body, blocks: _blocks, ...card } = detail;
  assert.deepEqual(page, { items: [card], total: 2, nextCursor: "authentic-next-cursor" });
  const second = await request(listingPath + "&cursor=" + page.nextCursor).then(value => value.json());
  assert.equal(second.items[0].title, other.title);
  assert.equal(second.nextCursor, null);
  const head = await request(detailsPath, { method: "HEAD" });
  assert.equal(head.headers.get("etag"), etag);
  assert.equal(await head.text(), "");
});

test("an active newer release or withdrawal disables both text and media, even with cached validators", async t => {
  const fixtureData = await fixture(t);
  const request = await listen(t, fixtureData);
  fixtureData.setActive({ ...original, snapshotHash: "c".repeat(64), title: "新的正式版本" });
  let reply = await request(detailsPath);
  assert.equal((await reply.json()).title, "新的正式版本");
  assert.equal(reply.headers.get("etag"), original.etag);
  assert.equal((await request(mediaPath, { headers: { "if-none-match": `"${sha256}"` } })).status, 404);

  fixtureData.setActive(null);
  reply = await request(detailsPath, { headers: { "if-none-match": original.etag } });
  assert.equal(reply.status, 410);
  assert.equal((await request(canonicalPath)).status, 410);
  assert.equal((await request(mediaPath)).status, 404);
  const list = await request("/public-api/content?locale=zh-CN&format=article").then(value => value.json());
  assert.deepEqual(list.items.map(item => item.canonicalPath), [other.canonicalPath]);
});

test("bundled image access validates hashes and reuses range, conditional and same-origin headers", async t => {
  const fixtureData = await fixture(t);
  const request = await listen(t, fixtureData);
  const image = await request(mediaPath);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("cache-control"), "private, no-store");
  assert.equal(image.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), rawPng);
  const range = await request(mediaPath, { headers: { Range: "bytes=0-7" } });
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), rawPng.subarray(0, 8));
  const head = await request(mediaPath, { method: "HEAD" });
  assert.equal(head.headers.get("content-length"), String(rawPng.length));
  assert.equal(await head.text(), "");
  const cache = await request(mediaPath, { headers: { "if-none-match": `"${sha256}"` } });
  assert.equal(cache.status, 304);
  const wrongHash = await request(`/public-media/overlay-${sha256}/${"b".repeat(64)}`);
  assert.equal(wrongHash.status, 404);
  assert.equal((await request(mediaPath + "?unknown=1")).status, 400);
  assert.equal((await request(mediaPath, { method: "POST" })).status, 405);
  const normalMedia = await request(`/public-media/MED-existing/${sha256}`);
  assert.equal((await normalMedia.json()).error.code, "ORIGINAL_MEDIA_NOT_FOUND");
  assert.deepEqual(fixtureData.mediaReads, [{ assetId: "MED-existing", options: { sha256, publicAccess: true } }]);

  const changed = Buffer.from(rawPng);
  changed[changed.length - 1] ^= 1;
  await writeFile(fixtureData.file, changed);
  const corrupt = await request(mediaPath, { headers: { "if-none-match": `"${sha256}"` } });
  assert.equal(corrupt.status, 404);
});

test("a release becoming unavailable during an image read denies even a matching ETag", async t => {
  const fixtureData = await fixture(t);
  const publicDetail = fixtureData.editorial.publicDetail;
  let observations = 0;
  fixtureData.editorial.publicDetail = input => {
    if (++observations === 2) fixtureData.setActive(null);
    return publicDetail(input);
  };
  const request = await listen(t, fixtureData);
  const response = await request(mediaPath, { headers: { "if-none-match": `"${sha256}"` } });
  assert.equal(observations, 2);
  assert.equal(response.status, 404);
});

test("private preview, redirects, English, unknown paths and route methods retain their old behavior", async t => {
  const fixtureData = await fixture(t);
  const request = await listen(t, fixtureData);
  assert.equal((await request("/admin")).headers.get("location"), "/login");
  assert.equal((await request("/about")).headers.get("location"), "/zh/about");
  const english = await request(`/public-api/content/en-US/article/${slug}`).then(value => value.json());
  assert.deepEqual(english, en);
  assert.equal((await request(detailsPath + "?filter=1")).status, 400);
  assert.equal((await request(detailsPath, { method: "POST" })).status, 405);
  assert.equal((await request(canonicalPath + "?filter=1")).status, 400);
  assert.equal((await request("/zh/articles/unknown")).status, 404);
  fixtureData.editorial.publicOrigin = "https://updated.example";
  const publicPage = await request(canonicalPath).then(value => value.text());
  const canonicalTag = `<link rel="canonical" href="${fixtureData.editorial.publicOrigin}${canonicalPath}"`;
  assert.ok(publicPage.includes(canonicalTag));
  const preview = await request(`/admin/preview/${baseReleaseId}`, { headers: { "x-fixture-auth": "preview" } });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("x-robots-tag"), "noindex, nofollow");
  const previewPage = await preview.text();
  assert.ok(previewPage.includes(canonicalTag));
  assert.equal(siteData(previewPage).detail.title, "独立私有预览");
  assert.equal((await request(`/admin/preview/${baseReleaseId}`)).status, 401);
  assert.equal((await request("/publication-overlay/articles.json", { headers: { "x-fixture-auth": "preview" } })).status, 404);
  assert.equal((await request(`/api/media/assets/overlay-${sha256}/bytes`)).status, 401);
});

test("absent bundle preserves ordinary operation and malformed configured bundles fail at startup", async t => {
  const absent = await fixture(t, { manifest: false });
  assert.equal(createPublicArticleOverlay(absent), null);
  const duplicates = await fixture(t, { rows: [article, article] });
  assert.throws(() => createPublicArticleOverlay(duplicates), /Duplicate canonical path/u);
  const invalidRange = await fixture(t, { rows: [{ ...article, assets: [{ ...article.assets[0], afterBlockIndex: 2 }] }] });
  assert.throws(() => createPublicArticleOverlay(invalidRange), /Invalid or duplicate image/u);
  const unknownField = await fixture(t, { rows: [{ ...article, localPath: "/private/never-publish" }] });
  assert.throws(() => createPublicArticleOverlay(unknownField), /未支持的字段/u);
});

test("an explicit private directory loads the existing artifact format and fails closed on missing or public bundles", async t => {
  const data = await fixture(t, { external: true });
  assert.equal(createPublicArticleOverlay(data).editorial.publicDetail({ locale: "zh-CN", format: "article", slug }).title, article.title);
  await mkdir(join(data.publicDir, "unsafe"));
  assert.throws(() => createPublicArticleOverlay({ ...data, articleOverlayDirectory: join(data.publicDir, "unsafe") }), /outside the public/u);
  assert.throws(() => createPublicArticleOverlay({ ...data, articleOverlayDirectory: "relative" }), /absolute path/u);
  await rm(join(data.overlayDir, "articles.json"));
  assert.throws(() => createPublicArticleOverlay(data), { code: "ENOENT" });
});

test("rollback can verify an inactive exact projection while its public media is still inaccessible", async t => {
  const data = await fixture(t, { external: true });
  const overlay = createPublicArticleOverlay(data);
  const projected = overlay.project(original);
  data.setActive(nativeRevision(projected));
  await assert.rejects(overlay.mediaAssets.openVerifiedAsset(projected.assets[0].assetId, { sha256, publicAccess: true }), { status: 404 });
  assert.equal(await overlay.verifyProjection(original), true);
  assert.equal(await overlay.verifyProjection(projected), true);
  assert.equal(await overlay.verifyProjection({ ...projected, releaseId: "REL-00002" }), false);
  assert.equal(await overlay.verifyProjection({ ...projected, snapshotHash: "b".repeat(64) }), false);

  const changed = Buffer.from(rawPng);
  changed[changed.length - 1] ^= 1;
  await writeFile(data.file, changed);
  assert.equal(await overlay.verifyProjection(projected), false);
  await writeFile(data.file, rawPng);
  await rm(join(data.overlayDir, "articles.json"));
  assert.equal(await overlay.verifyProjection(projected), false);
});

test("takeover parity ignores native release and image routing IDs but demands exact copy, structure and provenance", async t => {
  const data = await fixture(t);
  const projected = createPublicArticleOverlay(data).editorial.publicDetail({ locale: "zh-CN", format: "article", slug });
  const candidate = { ...nativeRevision(projected), preview: true, releaseStatus: "approved" };
  assert.equal(assertArticleTakeoverParity(projected, candidate), articleTakeoverFingerprint(projected));
  for (const changed of [
    { ...candidate, body: candidate.body + "。" },
    { ...candidate, canonicalUrl: candidate.canonicalUrl + "-other" },
    { ...candidate, blocks: [candidate.blocks[0], candidate.blocks[2], candidate.blocks[1]] },
    { ...candidate, assets: [{ ...candidate.assets[0], sha256: "b".repeat(64) }] },
    { ...candidate, sources: [] },
  ]) {
    assert.throws(() => assertArticleTakeoverParity(projected, changed), { code: "ARTICLE_TAKEOVER_PARITY_MISMATCH" });
  }
  const provenanceMismatch = { ...candidate, blocks: candidate.blocks.map(block => block.type === "image" ?
    { ...block, caption: "不一致的图注" } : block) };
  assert.throws(() => assertArticleTakeoverParity(projected, provenanceMismatch), { code: "ARTICLE_TAKEOVER_ARTICLE_INVALID" });
});

test("the legacy image route delegates to the same article's active verified CMS asset after takeover", async t => {
  const data = await fixture(t, { legacyAlias: true, external: true });
  const request = await listen(t, data);
  const projected = await request(detailsPath).then(response => response.json());
  assert.equal((await request(mediaPath)).status, 200);
  const candidate = nativeRevision(projected);
  const alias = { canonicalPath, sha256, assetId: cmsAssetId, releaseId: candidate.releaseId };
  data.setActive(candidate);
  data.setAlias(alias);
  data.setCmsReader(() => open(data.cmsFile));
  const migrated = await request(mediaPath);
  assert.equal(migrated.status, 200);
  assert.deepEqual(Buffer.from(await migrated.arrayBuffer()), rawPng);
  assert.deepEqual(data.mediaReads, [{ assetId: cmsAssetId, options: { sha256, publicAccess: true } }]);
  assert.equal((await request(detailsPath).then(response => response.json())).releaseId, candidate.releaseId);

  data.setAlias({ ...alias, canonicalPath: other.canonicalPath });
  assert.equal((await request(mediaPath)).status, 404);
  data.setAlias(alias);
  data.setActive(null);
  assert.equal((await request(mediaPath, { headers: { "if-none-match": `"${sha256}"` } })).status, 404);
});

test("persistent aliases cannot serve an unlinked or concurrently superseded image after the bundle is retired", async t => {
  const data = await fixture(t, { manifest: false, legacyAlias: true });
  const overlay = createPublicArticleOverlay(data);
  assert.equal(overlay.editorial, data.editorial);
  const assets = [{ id: cmsAssetId, assetId: cmsAssetId, kind: "image", mime: "image/png", role: "image", sha256 }];
  const candidate = { ...original, assets, releaseId: "REL-00012" };
  const alias = { canonicalPath, sha256, assetId: cmsAssetId, releaseId: candidate.releaseId };
  data.setActive(candidate);
  data.setAlias(alias);
  data.setCmsReader(() => open(data.cmsFile));
  const result = await overlay.mediaAssets.openVerifiedAsset("overlay-" + sha256, { sha256, publicAccess: true });
  try { assert.deepEqual(await result.handle.readFile(), rawPng); }
  finally { await result.handle.close(); }
  await assert.rejects(overlay.mediaAssets.openVerifiedAsset("overlay-" + sha256, { sha256 }), { status: 404 });

  let handle;
  data.setCmsReader(async () => {
    handle = await open(data.cmsFile);
    data.setActive({ ...candidate, releaseId: "REL-00013" });
    return handle;
  });
  await assert.rejects(overlay.mediaAssets.openVerifiedAsset("overlay-" + sha256, { sha256, publicAccess: true }), { status: 404 });
  assert.equal(handle.fd, -1);
});

test("offline intake preserves deployed content and media placement and requires the administrator's real references", async t => {
  const secondPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const secondSha256 = createHash("sha256").update(secondPng).digest("hex");
  const secondAssetId = "MED-" + "4".repeat(32);
  const source = { ...article, assets: [article.assets[0],
    { ...article.assets[0], sha256: secondSha256, size: secondPng.length, afterBlockIndex: 1,
      alt: "第二张图的替代文字", caption: "第二张图的说明" }] };
  const data = await fixture(t, { rows: [source] });
  const secondPath = join(data.overlayDir, "media", `${secondSha256}.png`);
  await writeFile(secondPath, secondPng);
  const manifestBytes = await readFile(join(data.overlayDir, "articles.json"));
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const manifest = JSON.parse(manifestBytes);
  const live = createPublicArticleOverlay(data).editorial.publicDetail({ locale: "zh-CN", format: "article", slug });
  const readback = { mode: "after", passed: true, manifestSha256,
    articles: [{ canonicalPath, valid: true, scope: "included", releaseId: baseReleaseId, snapshotHash: live.snapshotHash,
      title: source.title, bodySha256: hashText(source.body), media: source.assets.map(asset => ({ sha256: asset.sha256, bytes: asset.size })) }] };
  const dossier = { destinationId: "DEST-001", items: [{ canonicalPath, storyId: "STY-001", claimIds: ["C-001"],
    articleType: "product", illustrations: [
      { assetId: cmsAssetId, sha256, kind: "architecture", anchor: "第一段", description: "第一幅架构图" },
      { assetId: secondAssetId, sha256: secondSha256, kind: "logic", anchor: "第二段", description: "第二幅逻辑图" },
    ] }] };
  const args = { overlayDirectory: data.overlayDir, readback, dossier };
  const prepared = await prepareArticleTakeoverBatch(args);
  assert.deepEqual(prepared, buildArticleTakeoverBatch({ manifest, manifestSha256, readback, dossier }));
  assert.equal(prepared.items[0].baseSnapshotHash, baseSnapshotHash);
  assert.equal(prepared.items[0].expectedPublicSnapshotHash, live.snapshotHash);
  assert.equal(prepared.items[0].illustrationPolicy, "diagram-pair-v1");
  assert.equal(prepared.items[0].body, source.body);
  assert.deepEqual(prepared.items[0].illustrations.map(item => item.caption), source.assets.map(asset => asset.caption));

  const wrongPlacement = structuredClone(dossier);
  wrongPlacement.items[0].illustrations[1].anchor = "第一段";
  assert.throws(() => buildArticleTakeoverBatch({ manifest, manifestSha256, readback, dossier: wrongPlacement }),
    { code: "ARTICLE_TAKEOVER_INPUT_MISMATCH" });
  const wrongManifest = { ...readback, manifestSha256: "c".repeat(64) };
  await assert.rejects(prepareArticleTakeoverBatch({ ...args, readback: wrongManifest }), { code: "ARTICLE_TAKEOVER_INPUT_MISMATCH" });
  const changed = Buffer.from(secondPng);
  changed[changed.length - 1] ^= 1;
  await writeFile(secondPath, changed);
  await assert.rejects(prepareArticleTakeoverBatch(args), { code: "MEDIA_ASSET_NOT_FOUND" });
});
