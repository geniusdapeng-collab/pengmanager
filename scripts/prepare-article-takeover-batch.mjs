import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { articleIllustrationBlockText } from "../src/domain/article-illustrations.mjs";
import { editorialInput } from "../src/domain/editorial.mjs";
import { normalizeRevisionBatch, REVISION_BATCH_DIAGRAM_POLICY } from "../src/domain/editorial-revision-batches.mjs";
import { ApiError } from "../src/domain/errors.mjs";
import { hashText } from "../src/domain/hash.mjs";
import { parseStrictJson } from "../src/domain/strict-json.mjs";
import { createPublicArticleOverlay } from "../src/http/article-overlay.mjs";

const SOURCE_SCHEMA = "pengmanager.public-article-overlay/v1";
const CMS_ASSET_ID = /^MED-[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const articleFields = ["canonicalPath", "storyId", "claimIds", "articleType", "illustrationPlanId", "illustrations"];
const imageFields = ["assetId", "sha256", "kind", "anchor", "description"];

function fail(message) {
  throw new ApiError(409, "ARTICLE_TAKEOVER_INPUT_MISMATCH", message);
}

function byPath(entries) {
  const mapped = new Map(entries.map(row => [row.canonicalPath, row]));
  if (mapped.size !== entries.length) fail("迁移证据包含重复的公开网址。");
  return mapped;
}

function normalizedExcerpt(value) {
  return value.replace(/\s+/gu, " ").trim();
}

function prepareIllustrations(row, source) {
  if (!Array.isArray(row.illustrations) || row.illustrations.length !== source.assets.length ||
      ![2, 3].includes(source.assets.length)) fail("须逐张提供原图摘要及对应的正式素材标识。");
  const illustrations = row.illustrations.map((image, index) => {
    editorialInput(image, imageFields);
    const original = source.assets[index];
    if (!CMS_ASSET_ID.test(image.assetId ?? "") || original.sha256 !== image.sha256) {
      fail("图片摘要、顺序或正式素材标识与直发稿不一致。");
    }
    const anchor = typeof image.anchor === "string" && normalizedExcerpt(image.anchor);
    if (!anchor || source.blocks.findIndex(block => normalizedExcerpt(articleIllustrationBlockText(block)).includes(anchor)) !== original.afterBlockIndex) {
      fail("正式配图锚点与直发稿的插入位置不一致。");
    }
    return { ...image, alt: original.alt, caption: original.caption };
  });
  if (new Set(illustrations.map(image => image.assetId)).size !== illustrations.length) fail("同篇文章的正式素材标识重复。");
  if (illustrations.length === 2) {
    if (!["technical", "product"].includes(row.articleType) ||
        new Set(illustrations.map(image => image.kind)).size !== 2 ||
        !illustrations.every(image => ["architecture", "logic"].includes(image.kind))) {
      fail("双图接管须明确技术或产品文章，并对应架构图和逻辑图。");
    }
  } else if (!row.illustrationPlanId) {
    fail("三图接管须提供已按现有后台流程准备完成的准确配图计划。");
  }
  return illustrations;
}

export function buildArticleTakeoverBatch({ manifest, manifestSha256, readback, dossier }) {
  editorialInput(dossier, ["destinationId", "items"]);
  if (manifest?.schema !== SOURCE_SCHEMA || !Array.isArray(manifest.articles) ||
      readback?.mode !== "after" || readback.passed !== true || !Array.isArray(readback.articles) ||
      typeof manifestSha256 !== "string" || !SHA256.test(manifestSha256) || readback.manifestSha256 !== manifestSha256) {
    fail("需要同一份直发清单及其通过核验的公网发布后回执。");
  }
  if (!Array.isArray(dossier.items) || !dossier.items.length) fail("请明确提供本轮要接管的文章和正式后台资料。");
  const sources = byPath(manifest.articles);
  const receipts = byPath(readback.articles);
  const items = dossier.items.map(row => {
    editorialInput(row, articleFields);
    const source = sources.get(row.canonicalPath), receipt = receipts.get(row.canonicalPath);
    if (!source || !receipt || receipt.valid !== true || receipt.scope !== "included" ||
        receipt.releaseId !== source.baseReleaseId || receipt.snapshotHash === source.baseSnapshotHash ||
        receipt.title !== source.title || typeof source.body !== "string" || receipt.bodySha256 !== hashText(source.body) ||
        !Array.isArray(source.assets) || !Array.isArray(source.blocks) ||
        !Array.isArray(receipt.media) || receipt.media.length !== source.assets.length ||
        receipt.media.some((image, index) => image.sha256 !== source.assets[index].sha256 || image.bytes !== source.assets[index].size)) {
      fail("直发稿、发布后回执或实际媒体清单不一致。");
    }
    const illustrations = prepareIllustrations(row, source);
    const { canonicalPath, baseReleaseId, baseSnapshotHash, title, summary, body, blocks } = source;
    return { storyId: row.storyId, canonicalPath, baseReleaseId, baseSnapshotHash, expectedPublicSnapshotHash: receipt.snapshotHash,
      title, summary, body, blocks, claimIds: row.claimIds, articleType: row.articleType, illustrations,
      ...(row.illustrationPlanId === undefined ? {} : { illustrationPlanId: row.illustrationPlanId }),
      ...(illustrations.length === 2 ? { illustrationPolicy: REVISION_BATCH_DIAGRAM_POLICY } : {}) };
  });
  const batch = { destinationId: dossier.destinationId, items };
  normalizeRevisionBatch(batch);
  return batch;
}

async function load(file) {
  const raw = await readFile(file);
  return { sha256: createHash("sha256").update(raw).digest("hex"), value: parseStrictJson(raw, { maxBytes: 8_000_000 }) };
}

export async function prepareArticleTakeoverBatch({ overlayDirectory, readback, dossier }) {
  const articleOverlayDirectory = resolve(overlayDirectory);
  const { value: manifest, sha256: manifestSha256 } = await load(join(articleOverlayDirectory, "articles.json"));
  const batch = buildArticleTakeoverBatch({ manifest, manifestSha256, readback, dossier });
  const originals = new Map(batch.items.map(item => [item.canonicalPath.split("/").at(-1), item]));
  // The original identity here enables local file verification. Live source
  // identity and permissions are checked again by the administrator intake API.
  const editorial = {
    publicDetail({ slug }) {
      const row = originals.get(slug);
      if (!row) throw new ApiError(404, "PUBLIC_CONTENT_NOT_FOUND", "不是本轮接管文章。");
      return { canonicalPath: row.canonicalPath, locale: "zh-CN", format: "article",
        releaseId: row.baseReleaseId, snapshotHash: row.baseSnapshotHash };
    },
  };
  const overlay = createPublicArticleOverlay({ articleOverlayDirectory, editorial });
  for (const item of batch.items) {
    const detail = overlay.editorial.publicDetail({ slug: item.canonicalPath.split("/").at(-1) });
    if (detail.snapshotHash !== item.expectedPublicSnapshotHash) fail("本地直发包生成的公开快照与回执不一致。");
    for (const asset of detail.assets) {
      const { handle } = await overlay.mediaAssets.openVerifiedAsset(asset.assetId, { sha256: asset.sha256, publicAccess: true });
      await handle.close();
    }
  }
  return batch;
}

async function main() {
  const { values } = parseArgs({ options: {
    "overlay-dir": { type: "string" }, readback: { type: "string" }, dossier: { type: "string" }, output: { type: "string" },
  } });
  if (!values["overlay-dir"] || !values.readback || !values.dossier || !values.output) {
    throw new Error("用法：node scripts/prepare-article-takeover-batch.mjs --overlay-dir DIR --readback RECEIPT.json --dossier INPUT.json --output BATCH.json");
  }
  const [{ value: readback }, { value: dossier }] = await Promise.all([load(values.readback), load(values.dossier)]);
  const batch = await prepareArticleTakeoverBatch({ overlayDirectory: values["overlay-dir"], readback, dossier });
  await writeFile(values.output, JSON.stringify(batch) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(`已准备 ${batch.items.length} 篇的本地接管输入。上线及授权须经正式管理入口。\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error.code ?? "ARTICLE_TAKEOVER_PREPARATION_FAILED"} ${error.message}\n`);
    process.exitCode = 1;
  });
}
