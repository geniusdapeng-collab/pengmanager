import {
  editorialId, editorialInput, editorialSensitiveFindings, editorialText, normalizeEditorialBlocks,
} from "./editorial.mjs";
import { ApiError } from "./errors.mjs";
import { ARTICLE_ILLUSTRATION_DIAGRAM_PAIR_POLICY } from "./article-illustrations.mjs";

export const REVISION_BATCH_MAX_ITEMS = 100;
export { ARTICLE_ILLUSTRATION_DIAGRAM_PAIR_POLICY as REVISION_BATCH_DIAGRAM_POLICY };

const SHA = /^[a-f0-9]{64}$/;
const ROUTE = /^\/zh\/articles\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const ITEM_FIELDS = ["storyId", "canonicalPath", "baseReleaseId", "baseSnapshotHash", "expectedPublicSnapshotHash",
  "title", "summary", "body", "blocks", "claimIds", "articleType", "illustrationPolicy", "illustrationPlanId", "illustrations"];
const ILLUSTRATION_FIELDS = ["kind", "anchor", "description", "alt", "caption", "assetId", "sha256"];

export function revisionBatchDigest(value, field) {
  if (typeof value !== "string" || !SHA.test(value)) {
    throw new ApiError(400, "EDITORIAL_BATCH_DIGEST_INVALID", `${field} 必须是 64 位小写 SHA-256。`);
  }
  return value;
}

function illustration(input) {
  editorialInput(input, ILLUSTRATION_FIELDS);
  if (!["architecture", "logic", "scene"].includes(input.kind)) {
    throw new ApiError(400, "EDITORIAL_BATCH_ILLUSTRATION_INVALID", "图片类型无效。");
  }
  return {
    kind: input.kind,
    anchor: editorialText(input.anchor, "anchor", 300),
    description: editorialText(input.description, "description", 1000),
    alt: editorialText(input.alt, "alt", 500),
    caption: editorialText(input.caption ?? "", "caption", 500, { empty: true }),
    assetId: editorialId(input.assetId, "assetId"),
    sha256: revisionBatchDigest(input.sha256, "sha256"),
  };
}

function normalizeItem(input) {
  editorialInput(input, ITEM_FIELDS);
  const storyId = editorialId(input.storyId, "storyId");
  const baseReleaseId = editorialId(input.baseReleaseId, "baseReleaseId");
  const match = typeof input.canonicalPath === "string" && ROUTE.exec(input.canonicalPath);
  if (!match || match[1].length > 100) {
    throw new ApiError(400, "EDITORIAL_BATCH_ROUTE_INVALID", "只能使用既有中文文章的正式路径。");
  }
  const title = editorialText(input.title, "title", 240);
  const summary = editorialText(input.summary ?? "", "summary", 2000, { empty: true });
  const body = editorialText(input.body, "body", 50_000, { preserve: true });
  const blocks = normalizeEditorialBlocks(input.blocks, body, []);
  if (editorialSensitiveFindings({ title, summary, body, blocks }).length) {
    throw new ApiError(400, "EDITORIAL_BATCH_SENSITIVE_INPUT", "稿件含有须先处理的敏感资料。");
  }
  if (!Array.isArray(input.claimIds) || input.claimIds.length > 100) {
    throw new ApiError(400, "EDITORIAL_BATCH_CLAIMS_INVALID", "选题内容的事实引用必须显式提交数组。");
  }
  const claimIds = input.claimIds.map(value => editorialId(value, "claimId"));
  if (new Set(claimIds).size !== claimIds.length) {
    throw new ApiError(400, "EDITORIAL_BATCH_CLAIMS_INVALID", "事实引用重复。");
  }
  if (input.articleType !== undefined && !["technical", "product", "lifestyle"].includes(input.articleType)) {
    throw new ApiError(400, "EDITORIAL_BATCH_ILLUSTRATION_INVALID", "文章配图类型无效。");
  }
  if (input.illustrationPolicy !== undefined && input.illustrationPolicy !== ARTICLE_ILLUSTRATION_DIAGRAM_PAIR_POLICY) {
    throw new ApiError(400, "EDITORIAL_BATCH_ILLUSTRATION_INVALID", "配图策略无效。");
  }
  if (input.illustrations !== undefined && (!Array.isArray(input.illustrations) || input.illustrations.length > 3)) {
    throw new ApiError(400, "EDITORIAL_BATCH_ILLUSTRATION_INVALID", "最多提交三条准确图片引用。");
  }
  const illustrations = (input.illustrations ?? []).map(illustration);
  if (new Set(illustrations.map(image => image.assetId)).size !== illustrations.length) {
    throw new ApiError(400, "EDITORIAL_BATCH_ILLUSTRATION_INVALID", "同篇文章的正式素材标识不可重复。");
  }
  if (editorialSensitiveFindings(illustrations).length) {
    throw new ApiError(400, "EDITORIAL_BATCH_SENSITIVE_INPUT", "图片说明含有须先处理的敏感资料。");
  }
  const illustrationPlanId = input.illustrationPlanId === undefined ? null
    : editorialId(input.illustrationPlanId, "illustrationPlanId");
  const expectedPublicSnapshotHash = input.expectedPublicSnapshotHash === undefined ? null
    : revisionBatchDigest(input.expectedPublicSnapshotHash, "expectedPublicSnapshotHash");
  return { storyId, baseReleaseId, canonicalPath: input.canonicalPath,
    baseSnapshotHash: revisionBatchDigest(input.baseSnapshotHash, "baseSnapshotHash"),
    slug: match[1], locale: "zh-CN", title, summary, body, blocks, claimIds,
    articleType: input.articleType ?? null, illustrationPolicy: input.illustrationPolicy ?? null,
    illustrationPlanId, illustrations, expectedPublicSnapshotHash };
}

export function normalizeRevisionBatch(input) {
  editorialInput(input, ["destinationId", "items"]);
  const destinationId = editorialId(input.destinationId, "destinationId");
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > REVISION_BATCH_MAX_ITEMS) {
    throw new ApiError(400, "EDITORIAL_BATCH_SIZE_INVALID", `每个官网修订批次须提交 1 至 ${REVISION_BATCH_MAX_ITEMS} 篇文章。`);
  }
  const items = input.items.map(normalizeItem);
  if (new Set(items.map(item => item.canonicalPath)).size !== items.length) {
    throw new ApiError(400, "EDITORIAL_BATCH_DUPLICATE_ROUTE", "同一批次的文章正式路径不可重复。");
  }
  return { destinationId, items };
}
