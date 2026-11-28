import { createHash } from "node:crypto";
import { constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { ApiError } from "../domain/errors.mjs";
import { editorialInput, editorialNamingFindings, editorialText, normalizeEditorialBlocks } from "../domain/editorial.mjs";
import { hashObject } from "../domain/hash.mjs";

const SCHEMA = "pengmanager.public-article-overlay/v1";
const SHA256 = /^[0-9a-f]{64}$/u;
const CANONICAL_PATH = /^\/zh\/articles\/([a-z0-9]+(?:-[a-z0-9]+)*)$/u;
const CMS_ASSET_ID = /^MED-[0-9a-f]{32}$/u;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const ASSET_PREFIX = "overlay-";
const ARTICLE_FIELDS = ["canonicalPath", "baseReleaseId", "baseSnapshotHash", "title", "summary", "body", "blocks", "assets"];
const IMAGE_FIELDS = ["sha256", "width", "height", "size", "alt", "caption", "afterBlockIndex"];

function requireOverlay(condition, message) {
  if (!condition) throw new Error(`PUBLIC_ARTICLE_OVERLAY_INVALID: ${message}`);
}

function readManifest(directory, required) {
  const file = join(directory, "articles.json");
  let info;
  try { info = lstatSync(file); }
  catch (error) {
    if (error.code === "ENOENT" && !required) return null;
    throw error;
  }
  requireOverlay(info.isFile(), "The bundle manifest must be a regular file.");
  const bytes = readFileSync(file);
  const manifest = JSON.parse(bytes.toString("utf8"));
  editorialInput(manifest, ["schema", "updatedAt", "articles"]);
  requireOverlay(manifest.schema === SCHEMA && typeof manifest.updatedAt === "string"
    && Number.isFinite(Date.parse(manifest.updatedAt)) && Array.isArray(manifest.articles)
    && manifest.articles.length > 0, "Expected a versioned bundle with dated articles.");
  return { ...manifest, updatedAt: new Date(manifest.updatedAt).toISOString(),
    manifestSha256: createHash("sha256").update(bytes).digest("hex") };
}

function readOverlayDirectory(publicDir, articleOverlayDirectory) {
  if (articleOverlayDirectory === undefined) return publicDir ? join(publicDir, "..", "publication-overlay") : null;
  requireOverlay(typeof articleOverlayDirectory === "string" && isAbsolute(articleOverlayDirectory),
    "The configured bundle directory must be an absolute path.");
  if (publicDir) {
    const fromPublic = relative(realpathSync(publicDir), realpathSync(articleOverlayDirectory));
    requireOverlay(fromPublic === ".." || fromPublic.startsWith(`..${sep}`) || isAbsolute(fromPublic),
      "The configured bundle directory must be outside the public file tree.");
  }
  return articleOverlayDirectory;
}

function readArticle(row, updatedAt, directory, imageEntries) {
  editorialInput(row, ARTICLE_FIELDS);
  const slug = CANONICAL_PATH.exec(row.canonicalPath)?.[1];
  requireOverlay(slug && slug.length <= 100 && /^REL-\d+$/u.test(row.baseReleaseId)
    && SHA256.test(row.baseSnapshotHash), "Expected an exact Chinese article path and original release fingerprint.");
  const title = editorialText(row.title, "title", 240);
  const summary = editorialText(row.summary, "summary", 2000, { empty: true });
  const body = editorialText(row.body, "body", 50_000, { preserve: true });
  requireOverlay(title === row.title && summary === row.summary
    && Array.isArray(row.blocks) && Array.isArray(row.assets) && row.assets.length <= 64,
  "Expected normalized article fields and bounded image references.");
  const textBlocks = normalizeEditorialBlocks(row.blocks, body, []);
  const placements = new Map();
  const hashes = new Set();
  const assets = row.assets.map(image => {
    editorialInput(image, IMAGE_FIELDS);
    const { sha256, width, height, size, afterBlockIndex } = image;
    requireOverlay(SHA256.test(sha256) && !hashes.has(sha256) && [width, height, size].every(value =>
      Number.isSafeInteger(value) && value > 0) && size >= 33 && Number.isInteger(afterBlockIndex)
      && afterBlockIndex >= 0 && afterBlockIndex < textBlocks.length, "Invalid or duplicate image metadata.");
    hashes.add(sha256);
    const alt = editorialText(image.alt, "alt", 1000);
    const caption = editorialText(image.caption, "caption", 2000, { empty: true });
    const assetId = `${ASSET_PREFIX}${sha256}`;
    const file = join(directory, "media", `${sha256}.png`);
    const info = lstatSync(file);
    requireOverlay(info.isFile() && info.size === size, "The bundled PNG is missing or its file size differs.");
    const entry = imageEntries.get(assetId) ?? { file, size, width, height, sha256, owners: [] };
    requireOverlay(entry.size === size && entry.width === width && entry.height === height, "Shared PNG metadata differs.");
    entry.owners.push(row.canonicalPath);
    imageEntries.set(assetId, entry);
    const placed = placements.get(afterBlockIndex) ?? [];
    placed.push({ type: "image", assetId, alt, caption });
    placements.set(afterBlockIndex, placed);
    return { id: assetId, assetId, sha256, url: `/public-media/${assetId}/${sha256}`,
      mime: "image/png", kind: "image", size, role: "image", alt, caption, locale: "zh-CN", width, height };
  });
  const blocks = textBlocks.flatMap((block, index) => [block, ...(placements.get(index) ?? [])]);
  const content = { title, summary, body, blocks, assets, updatedAt };
  requireOverlay(!editorialNamingFindings({ ...content, assetRefs: assets }, "editorial").length,
    "The public article or its image descriptions contain an unresolved product name.");
  return { canonicalPath: row.canonicalPath, slug, baseReleaseId: row.baseReleaseId, baseSnapshotHash: row.baseSnapshotHash,
    content, snapshotHash: hashObject({ schema: SCHEMA, canonicalPath: row.canonicalPath,
      baseReleaseId: row.baseReleaseId, baseSnapshotHash: row.baseSnapshotHash, ...content }) };
}

function matchesOriginal(article, detail) {
  return article && detail?.locale === "zh-CN" && detail.format === "article" &&
    detail.canonicalPath === article.canonicalPath && detail.releaseId === article.baseReleaseId &&
    detail.snapshotHash === article.baseSnapshotHash;
}

function unavailableImage() {
  return new ApiError(404, "MEDIA_ASSET_NOT_FOUND", "素材不存在。");
}

async function openBundledImage(entry) {
  let handle;
  try { handle = await open(entry.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (["ENOENT", "ELOOP"].includes(error.code)) throw unavailableImage();
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== entry.size) throw unavailableImage();
    const data = await handle.readFile();
    const after = await handle.stat();
    if (data.length !== entry.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        !data.subarray(0, 8).equals(PNG_SIGNATURE) || data.toString("ascii", 12, 16) !== "IHDR" ||
        data.readUInt32BE(16) !== entry.width || data.readUInt32BE(20) !== entry.height ||
        createHash("sha256").update(data).digest("hex") !== entry.sha256) throw unavailableImage();
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// This content bundle is independent of the editorial store. It applies only
// to the public read surface of the exact release that was active at assembly.
export function createPublicArticleOverlay({ publicDir, editorial, mediaAssets, articleOverlayDirectory }) {
  if (!editorial) return null;
  const directory = readOverlayDirectory(publicDir, articleOverlayDirectory);
  const manifest = directory && readManifest(directory, articleOverlayDirectory !== undefined);
  const hasAliasLookup = typeof editorial.publicArticleMediaAlias === "function";
  if (!manifest && !hasAliasLookup) return null;

  const articles = new Map();
  const imageEntries = new Map();
  for (const row of manifest?.articles ?? []) {
    const article = readArticle(row, manifest.updatedAt, directory, imageEntries);
    requireOverlay(!articles.has(article.canonicalPath), "Duplicate canonical path.");
    articles.set(article.canonicalPath, article);
  }

  function project(detail) {
    const article = articles.get(detail.canonicalPath);
    if (!matchesOriginal(article, detail)) return detail;
    const { etag: _previousEtag, ...current } = detail;
    const projected = { ...current, ...article.content, snapshotHash: article.snapshotHash };
    return { ...projected, etag: `"${hashObject(projected)}"` };
  }

  // The previous route is inactive until rollback commits. Verify the protected
  // source directly and let the normal public route gate continue to protect it.
  async function verifyProjection(detail) {
    const article = articles.get(detail?.canonicalPath);
    if (!article || detail.locale !== "zh-CN" || detail.format !== "article" || detail.releaseId !== article.baseReleaseId ||
        (detail.snapshotHash !== article.baseSnapshotHash && detail.snapshotHash !== article.snapshotHash)) return false;
    if (readManifest(directory, false)?.manifestSha256 !== manifest.manifestSha256) return false;
    for (const { assetId } of article.content.assets) {
      try {
        const handle = await openBundledImage(imageEntries.get(assetId));
        await handle.close();
      } catch (error) {
        if (error instanceof ApiError && error.code === "MEDIA_ASSET_NOT_FOUND") return false;
        throw error;
      }
    }
    return true;
  }

  function readPublicArticle(slug) {
    try {
      return editorial.publicDetail({ locale: "zh-CN", format: "article", slug });
    } catch (error) {
      if (error instanceof ApiError && [404, 410].includes(error.status)) return null;
      throw error;
    }
  }

  function bundledImageIsPublic(entry) {
    return entry.owners.some(path => {
      const article = articles.get(path);
      return matchesOriginal(article, readPublicArticle(article.slug));
    });
  }

  function verifiedAlias(legacyAssetId, sha256) {
    if (!hasAliasLookup) return null;
    const alias = editorial.publicArticleMediaAlias(legacyAssetId, sha256);
    if (!alias || alias.sha256 !== sha256 || !CMS_ASSET_ID.test(alias.assetId ?? "")) return null;
    const slug = CANONICAL_PATH.exec(alias.canonicalPath)?.[1];
    if (!slug) return null;
    const detail = readPublicArticle(slug);
    if (detail?.canonicalPath !== alias.canonicalPath || detail.releaseId !== alias.releaseId ||
        !detail.assets?.some(asset => asset.assetId === alias.assetId && asset.sha256 === sha256 &&
          asset.kind === "image" && asset.role === "image" && asset.mime === "image/png")) return null;
    return alias;
  }

  async function openMigratedImage(legacyAssetId, sha256) {
    const alias = verifiedAlias(legacyAssetId, sha256);
    if (!mediaAssets || !alias) throw unavailableImage();
    const opened = await mediaAssets.openVerifiedAsset(alias.assetId, { sha256, publicAccess: true });
    try {
      const current = verifiedAlias(legacyAssetId, sha256);
      if (!current || current.assetId !== alias.assetId || current.releaseId !== alias.releaseId ||
          current.canonicalPath !== alias.canonicalPath) throw unavailableImage();
      return opened;
    } catch (error) {
      await opened.handle.close();
      throw error;
    }
  }

  return {
    project, verifyProjection,
    editorial: manifest ? {
      get publicOrigin() { return editorial.publicOrigin; },
      previewRelease: id => editorial.previewRelease(id),
      publicDetail: input => project(editorial.publicDetail(input)),
      publicList(input) {
        const page = editorial.publicList(input);
        return { ...page, items: page.items.map(card => {
          const projected = project(card);
          if (projected === card) return card;
          const { body: _body, blocks: _blocks, ...rest } = projected;
          return rest;
        }) };
      },
    } : editorial,
    mediaAssets: {
      async openVerifiedAsset(assetId, options) {
        if (!assetId.startsWith(ASSET_PREFIX)) {
          if (!mediaAssets) throw unavailableImage();
          return mediaAssets.openVerifiedAsset(assetId, options);
        }
        const sha256 = options?.sha256;
        if (!options?.publicAccess || typeof sha256 !== "string" || !SHA256.test(sha256) ||
            assetId !== ASSET_PREFIX + sha256) throw unavailableImage();
        const entry = imageEntries.get(assetId);
        if (!entry || !bundledImageIsPublic(entry)) return openMigratedImage(assetId, sha256);
        const handle = await openBundledImage(entry);
        try {
          if (!bundledImageIsPublic(entry)) throw unavailableImage();
          return { asset: { mime: "image/png", size: entry.size, sha256: entry.sha256 }, handle };
        } catch (error) {
          await handle.close();
          throw error;
        }
      },
    },
  };
}
