import { EDITORIAL_LOCALES, editorialText } from "./editorial.mjs";
import { ApiError } from "./errors.mjs";
import { hashObject } from "./hash.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const BLOCK_TYPES = new Set(["paragraph", "quote", "heading", "list", "code", "image"]);
const IMAGE_ROLES = new Set(["image", "cover", "poster"]);

function invalid() {
  return new ApiError(422, "ARTICLE_TAKEOVER_ARTICLE_INVALID", "接管校验需要完整的公开文章、结构块、图片和来源快照。");
}

export function articleTakeoverFingerprint(article) {
  if (!article || article.format !== "article" || !EDITORIAL_LOCALES.includes(article.locale) ||
      typeof article.canonicalPath !== "string" || !/^\/(zh|en)\/articles\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(article.canonicalPath) ||
      typeof article.canonicalUrl !== "string" || !Array.isArray(article.blocks) || !article.blocks.length ||
      !Array.isArray(article.assets) || !Array.isArray(article.sources)) throw invalid();
  const { canonicalPath, canonicalUrl, locale, title, summary, body, sources } = article;
  editorialText(title, "title", 240, { preserve: true });
  editorialText(summary, "summary", 2000, { empty: true, preserve: true });
  editorialText(body, "body", 50_000, { preserve: true });

  const byId = new Map();
  const assets = article.assets.map(asset => {
    const id = asset?.assetId ?? asset?.id;
    if (typeof id !== "string" || byId.has(id) || typeof asset.sha256 !== "string" || !SHA256.test(asset.sha256) ||
        asset.kind !== "image" || !IMAGE_ROLES.has(asset.role) || !["image/png", "image/jpeg", "image/webp"].includes(asset.mime) ||
        asset.locale !== locale || typeof asset.alt !== "string" || typeof asset.caption !== "string" ||
        ![asset.width, asset.height, asset.size].every(value => Number.isSafeInteger(value) && value > 0)) throw invalid();
    const { sha256, mime, role, width, height, size, alt, caption } = asset;
    const image = { sha256, mime, role, width, height, size, alt, caption };
    byId.set(id, image);
    return image;
  });
  const blocks = article.blocks.map(block => {
    if (!block || !BLOCK_TYPES.has(block.type)) throw invalid();
    if (block.type !== "image") return block;
    const { assetId, ...image } = block;
    const asset = byId.get(assetId);
    if (!asset || image.alt !== asset.alt || image.caption !== asset.caption) throw invalid();
    return { ...image, sha256: asset.sha256 };
  });

  // These are two real rendered article DTOs. Release IDs, media routes and
  // timestamps belong to the release system and are expected to change.
  return hashObject({ canonicalPath, canonicalUrl, locale, title, summary, body, blocks, assets, sources });
}

export function assertArticleTakeoverParity(liveProjection, cmsPreviewDto) {
  const live = articleTakeoverFingerprint(liveProjection);
  if (live !== articleTakeoverFingerprint(cmsPreviewDto)) {
    throw new ApiError(409, "ARTICLE_TAKEOVER_PARITY_MISMATCH", "正式候选的正文、图片或来源与当前公开稿不同。");
  }
  return live;
}
