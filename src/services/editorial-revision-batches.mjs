import { randomUUID } from "node:crypto";
import { ApiError } from "../domain/errors.mjs";
import { assertArticleTakeoverParity } from "../domain/article-takeover.mjs";
import { editorialId, editorialInput, editorialSensitiveFindings, editorialText } from "../domain/editorial.mjs";
import { articleIllustrationSourceHash, placeArticleIllustrations } from "../domain/article-illustrations.mjs";
import { hashObject } from "../domain/hash.mjs";
import { normalizeRevisionBatch, REVISION_BATCH_DIAGRAM_POLICY, revisionBatchDigest } from "../domain/editorial-revision-batches.mjs";
import { createPublicArticleOverlay } from "../http/article-overlay.mjs";
import { JsonStore } from "../storage/json-store.mjs";

const PUBLISH_GROUP_SIZE = 5;
const AUTHORIZATION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const REVIEW_MAX_POLLS = 20;
const STATE_FIELDS = ["revisionBatches", "destinations", "stories", "editions", "websiteRoutes", "websiteReleases",
  "claims", "mediaAssets", "editorialRequests"];
const RETRYABLE = new Set(["blocked", "failed", "awaiting_review"]);
const REVIEW_CODES = new Set(["AI_APPROVAL_PENDING", "AI_APPROVAL_WORKER_REQUIRED", "NATIVE_APPROVAL_VERDICT_INVALID"]);
const IDENTITY_SCOPES = new Set(["prepare", "workflow", "activate", "readback"]);

function fail(status, code, message) { throw new ApiError(status, code, message); }

function requireEditor(ctx) {
  if (!["local", "session"].includes(ctx?.method)) {
    fail(403, "AGENT_SCOPE_DENIED", "官网批量修订仅允许管理员。");
  }
  return editorialText(ctx.actor, "actor", 120);
}

function writeIdentity(input, scope, ctx) {
  const actor = requireEditor(ctx);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(ctx.idempotencyKey ?? "")) {
    fail(400, "IDEMPOTENCY_KEY_REQUIRED", "官网批量修订写入需要有效的 Idempotency-Key。");
  }
  return { actor, keyHash: hashObject({ actor, scope, key: ctx.idempotencyKey }), requestHash: hashObject(input) };
}

function batchEtag(batch) { return `"${batch.id}-${batch.revision}"`; }

function failure(error) {
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{2,90}$/.test(error.code)
    ? error.code : "EDITORIAL_BATCH_STEP_FAILED";
  const message = error instanceof ApiError && !editorialSensitiveFindings(error.message).length
    ? error.message : "处理未完成，请先核对保存的进度后重试。";
  const proofKey = error?.details?.workflow?.proofKey;
  const reviewId = error?.details?.reviewId;
  return { code, message, ...(typeof proofKey === "string" &&
    /^editorial\.(?:variant|website_release):[A-Za-z0-9_-]{1,100}:[a-f0-9]{64}$/.test(proofKey) ? { proofKey } : {}),
    ...(typeof reviewId === "string" && /^[a-f0-9]{64}$/.test(reviewId) ? { reviewId } : {}) };
}

function authorizationValid(item, now) {
  return Boolean(item.authorization && Date.parse(item.authorization.expiresAt) > now.getTime());
}

function findBatch(state, id) {
  const batch = (state.revisionBatches ?? []).find(row => row.id === id);
  if (!batch) fail(404, "EDITORIAL_BATCH_NOT_FOUND", "找不到此官网批量修订。");
  return batch;
}

function findItem(batch, id) {
  const item = batch.items.find(row => row.id === id);
  if (!item) fail(404, "EDITORIAL_BATCH_ITEM_NOT_FOUND", "找不到此文章修订项目。");
  return item;
}

function itemView(item) {
  const { title, summary, body, blocks, claimIds, canonicalPath, storyId, baseReleaseId, baseSnapshotHash,
    expectedPublicSnapshotHash, illustrations } = item.draft;
  return { id: item.id, status: item.status, stage: item.stage, storyId, canonicalPath, baseReleaseId, baseSnapshotHash,
    expectedPublicSnapshotHash,
    title, summary, body, blocks, claimIds, illustrations, illustrationPlanId: item.planId,
    editionId: item.editionId, editionSnapshotHash: item.editionSnapshotHash,
    releaseId: item.releaseId, receipt: item.receipt, error: item.error, updatedAt: item.updatedAt, elapsedMs: item.elapsedMs ?? 0,
    stageStartedAt: item.stageStartedAt ?? item.startedAt, stageDurationsMs: item.stageDurationsMs ?? {},
    authorizedBy: item.authorization?.actor ?? null, authorizedAt: item.authorization?.at ?? null,
    authorizationExpiresAt: item.authorization?.expiresAt ?? null };
}

function batchView(batch, includeItems = true, pagination = null) {
  const counts = {};
  for (const item of batch.items) counts[item.status] = (counts[item.status] ?? 0) + 1;
  const rows = pagination ? batch.items.slice(pagination.offset, pagination.offset + pagination.limit) : batch.items;
  return { id: batch.id, manifestHash: batch.manifestHash, destinationId: batch.destinationId, createdAt: batch.createdAt,
    updatedAt: batch.updatedAt, etag: batchEtag(batch), counts, ...(includeItems ? { items: rows.map(itemView) } : {}),
    ...(pagination ? { page: { ...pagination, total: batch.items.length } } : {}) };
}

function currentBase(state, draft) {
  const story = state.stories.find(row => row.id === draft.storyId);
  if (!story || story.status === "archived") fail(409, "EDITORIAL_BATCH_STORY_UNAVAILABLE", "原文章选题不存在或不可修订。");
  const route = state.websiteRoutes.find(row => row.canonicalPath === draft.canonicalPath && row.storyId === draft.storyId);
  const release = state.websiteReleases.find(row => row.id === route?.activeReleaseId);
  if (!release || release.id !== draft.baseReleaseId || release.snapshotHash !== draft.baseSnapshotHash ||
      release.status !== "published" || release.receipt?.dataMode !== "real" || release.locale !== draft.locale ||
      release.format !== "article" || release.siteId !== "official-site" ||
      release.storyId !== draft.storyId || release.canonicalPath !== draft.canonicalPath) {
    fail(409, "EDITORIAL_BATCH_BASE_CHANGED", "正式地址当前版本或摘要已变化，须重新核对导入范围。");
  }
  return { story, route, release };
}

function latestEdition(state, draft) {
  return state.editions.filter(row => row.storyId === draft.storyId && row.locale === draft.locale && row.format === "article")
    .sort((a, b) => b.editorialRevision - a.editorialRevision)[0];
}

function stepKey(batchId, itemId, scope, input) { return hashObject([batchId, itemId, scope, input]); }

function normalizeRetryProofs(input) {
  editorialInput(input, ["reviewProofs"]);
  if (input.reviewProofs === undefined) return {};
  if (!input.reviewProofs || Object.getPrototypeOf(input.reviewProofs) !== Object.prototype
      || Object.keys(input.reviewProofs).length > 2 || Object.keys(input.reviewProofs).some(
        key => !/^editorial\.(?:variant|website_release):[A-Za-z0-9_-]{1,100}:[a-f0-9]{64}$/.test(key))
      || editorialSensitiveFindings(input.reviewProofs).length) {
    fail(400, "EDITORIAL_BATCH_REVIEW_PROOFS_INVALID", "审核凭据须对应当前候选和准确审核类型。");
  }
  return input.reviewProofs;
}

export class EditorialRevisionBatchService {
  #draining = null;
  #needsWake = false;
  #closed = false;
  #ready = false;
  #recovery = null;
  #reviewTimer = null;
  #workerFailure = null;
  #publicReadModel = null;

  constructor({ store, editorial, mediaAssets, publicEditorial, clock = () => new Date(), overlayDirectory, autoRun = true }) {
    this.store = store;
    this.editorial = editorial;
    this.mediaAssets = mediaAssets;
    this.clock = clock;
    this.overlayDirectory = overlayDirectory;
    this.#publicReadModel = publicEditorial ?? null;
    this.autoRun = autoRun;
  }

  static validateExecution(state, ctx, scope, input, now = new Date()) {
    if (ctx?.method !== "editorial-batch" || typeof ctx.operationToken !== "string") return false;
    const batch = state.revisionBatches?.find(row => row.id === ctx.batchId);
    const item = batch?.items.find(row => row.id === ctx.itemId);
    const operation = item?.operation;
    if (!operation || !IDENTITY_SCOPES.has(operation.kind) || operation.token !== ctx.operationToken
        || operation.actor !== ctx.actor) return false;
    if (operation.kind === "readback") {
      return item.status === "publishing" && item.releaseId === operation.releaseId && operation.ifMatch === ctx.ifMatch
        && operation.scope === scope && operation.inputHash === hashObject(input)
        && state.websiteRoutes?.some(row => row.canonicalPath === item.draft.canonicalPath && row.activeReleaseId === item.releaseId);
    }
    if (operation.kind !== "prepare" && !authorizationValid(item, now)) return false;
    if (operation.kind === "workflow") {
      const original = item.workflowAuthorization;
      if (item.status !== "publishing" || original?.actor !== ctx.actor || item.editionId !== operation.editionId
          || original.editionSnapshotHash !== item.authorization.editionSnapshotHash) return false;
      if (scope === undefined) return true;
      const previousContentId = item.previousContentId ?? null;
      if (scope === `website_ai_authorized:${item.editionId}`) return input.editionId === item.editionId
        && input.editionSnapshotHash === item.authorization.editionSnapshotHash && input.destinationId === batch.destinationId
        && input.slug === item.draft.slug && input.expectedPreviousReleaseId === item.draft.baseReleaseId
        && input.supersedesContentId === previousContentId && input.authorizationNote === original.note;
      if (scope === `variant_created:${item.editionId}`) return input.destinationId === batch.destinationId
        && (input.supersedesContentId ?? null) === previousContentId;
      const member = /^variant_transitioned:([A-Za-z0-9_-]+)$/.exec(scope);
      if (member) return ["fact_check", "approved", "scheduled"].includes(input.target)
        && Boolean(state.content?.some(row => row.id === member[1] && row.editionId === item.editionId
          && row.destinationId === batch.destinationId));
      if (scope === "release_created") return input.slug === item.draft.slug
        && Boolean(state.content?.some(row => row.id === input.contentId && row.editionId === item.editionId
          && row.destinationId === batch.destinationId));
      const release = /^release_(approved|verified):([A-Za-z0-9_-]+)$/.exec(scope);
      return Boolean(release && state.websiteReleases?.some(row => row.id === release[2] && row.editionId === item.editionId
        && row.canonicalPath === item.draft.canonicalPath && row.previousReleaseId === item.draft.baseReleaseId
        && (release[1] === "approved" ? input.snapshotHash === row.snapshotHash && input.authorizationNote === original.note
          : row.id === item.releaseId && input.confirm === true)));
    }
    if (scope === undefined) return operation.kind === "activate" && item.status === "publishing"
      && item.authorization?.actor === ctx.actor && item.releaseId === operation.releaseId && operation.ifMatch === ctx.ifMatch;
    return operation.scope === scope && operation.inputHash === hashObject(input) && operation.ifMatch === ctx.ifMatch
      && (operation.kind === "prepare" ? item.status === "preparing" && batch.createdBy === ctx.actor
        : item.status === "publishing" && item.authorization?.actor === ctx.actor && item.releaseId === operation.releaseId);
  }

  list(ctx) {
    requireEditor(ctx);
    const batches = this.#state().revisionBatches ?? [];
    return { items: batches.slice(-50).reverse().map(batch => batchView(batch, false)), workerError: this.#workerFailure };
  }

  get(id, ctx, pagination) {
    requireEditor(ctx);
    return { ...batchView(findBatch(this.#state(), id), true, pagination), workerError: this.#workerFailure };
  }

  preflight(input, ctx) {
    requireEditor(ctx);
    const manifest = normalizeRevisionBatch(input);
    const state = this.#state();
    this.#checkDestination(state, manifest.destinationId);
    return { manifestHash: hashObject(manifest), items: manifest.items.map(draft => this.#preflightItem(state, draft)) };
  }

  async create(input, ctx) {
    const identity = writeIdentity(input, "revision-batches:create", ctx);
    const manifest = normalizeRevisionBatch(input);
    const { result } = await this.store.mutate({ type: "editorial.revision_batch_created", actor: identity.actor,
      payload: { manifestHash: hashObject(manifest), itemCount: manifest.items.length }, includeState: false }, state => {
      const persisted = state.revisionBatches ??= [];
      const duplicate = persisted.find(batch => batch.createKeyHash === identity.keyHash);
      if (duplicate) {
        if (duplicate.createRequestHash !== identity.requestHash) {
          fail(409, "IDEMPOTENCY_CONFLICT", "此幂等键已用于不同请求。");
        }
        return JsonStore.noChange(batchView(duplicate));
      }
      this.#checkDestination(state, manifest.destinationId);
      const now = this.clock().toISOString();
      const batch = { id: `ERB-${randomUUID()}`, createdBy: identity.actor, revision: 1, createdAt: now, updatedAt: now,
        createKeyHash: identity.keyHash, createRequestHash: identity.requestHash,
        manifestHash: hashObject(manifest), destinationId: manifest.destinationId, requests: [],
        items: manifest.items.map((draft, index) => {
          const preflight = this.#preflightItem(state, draft);
          return { id: `item-${index + 1}`, draft, baseEditionId: preflight.baseEditionId,
            previousContentId: preflight.previousContentId, status: preflight.error ? "blocked" : "preparing",
            stage: preflight.error ? "preflight" : "edition", error: preflight.error,
            planId: draft.illustrationPlanId, editionId: null, editionSnapshotHash: null, releaseId: null, receipt: null,
            authorization: null, workflowAuthorization: null, operation: null, reviewProofs: {}, expectedReview: null,
            reviewPolling: null, updatedAt: now, startedAt: now, elapsedMs: 0, stageStartedAt: now, stageDurationsMs: {} };
        }) };
      persisted.push(batch);
      return batchView(batch);
    });
    this.#schedule();
    return result;
  }

  async authorize(id, input, ctx) {
    editorialInput(input, ["manifestHash", "items", "authorizationNote"]);
    revisionBatchDigest(input.manifestHash, "manifestHash");
    const note = editorialText(input.authorizationNote, "authorizationNote", 2000);
    if (note.length < 8 || editorialSensitiveFindings(note).length) {
      fail(400, "EDITORIAL_BATCH_AUTHORIZATION_NOTE_INVALID", "需要注明本次公开授权的实际范围。");
    }
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) {
      fail(400, "EDITORIAL_BATCH_AUTHORIZATION_INVALID", "请选择实际核对过的文章。");
    }
    const items = input.items.map(item => {
      editorialInput(item, ["id", "editionSnapshotHash"]);
      return { id: editorialId(item.id), editionSnapshotHash: revisionBatchDigest(item.editionSnapshotHash, "editionSnapshotHash") };
    });
    if (new Set(items.map(item => item.id)).size !== items.length) {
      fail(400, "EDITORIAL_BATCH_AUTHORIZATION_INVALID", "授权文章不能重复。");
    }
    const result = await this.#editorWrite(id, "authorized", input, ctx, (state, batch, actor, now) => {
      if (batch.manifestHash !== input.manifestHash) fail(409, "EDITORIAL_BATCH_MANIFEST_CHANGED", "请重新核对准确的批次。");
      this.#checkDestination(state, batch.destinationId);
      for (const selected of items) {
        const item = findItem(batch, selected.id);
        const edition = latestEdition(state, item.draft);
        if (item.status !== "ready" || item.editionSnapshotHash !== selected.editionSnapshotHash ||
            edition?.id !== item.editionId || edition.snapshotHash !== selected.editionSnapshotHash) {
          fail(409, "EDITORIAL_BATCH_EDITION_CHANGED", "有文章母稿尚未准备好或已变化，请重新核对批次。");
        }
        currentBase(state, item.draft);
        if (item.draft.expectedPublicSnapshotHash) this.#expectedPublic(item.draft);
        const previousStage = item.stage;
        item.authorization = { actor, at: now, note, editionSnapshotHash: selected.editionSnapshotHash,
          expiresAt: new Date(Date.parse(now) + AUTHORIZATION_LIFETIME_MS).toISOString() };
        item.status = "queued"; item.stage = "approval"; item.error = null;
        this.#touch(item, now, previousStage);
      }
    });
    this.#schedule();
    return result;
  }

  async retry(id, itemId, input, ctx) {
    const reviewProofs = normalizeRetryProofs(input);
    const result = await this.#editorWrite(id, `item_retry:${itemId}`, input, ctx, (state, batch) => {
      const item = findItem(batch, itemId);
      const previousStage = item.stage;
      if (!RETRYABLE.has(item.status)) fail(409, "EDITORIAL_BATCH_ITEM_NOT_RETRYABLE", "仅可重试已阻断、失败或待审核项目。");
      if (Object.keys(reviewProofs).length && (!item.authorization || !item.error?.proofKey
          || Object.keys(reviewProofs).some(key => key !== item.error.proofKey))) {
        fail(409, "EDITORIAL_BATCH_REVIEW_PROOFS_INVALID", "仅可补交当前待审核项目请求的签章。");
      }
      this.#checkDestination(state, batch.destinationId);
      const release = state.websiteReleases.find(row => row.id === item.releaseId);
      const active = state.websiteRoutes.find(row => row.canonicalPath === item.draft.canonicalPath);
      if (release?.id !== active?.activeReleaseId || !release) {
        const preflight = this.#preflightItem(state, item.draft, item);
        if (preflight.error) fail(409, preflight.error.code, preflight.error.message);
        if (!item.baseEditionId) item.baseEditionId = preflight.baseEditionId;
        if (!item.previousContentId) item.previousContentId = preflight.previousContentId;
        if (item.authorization && !authorizationValid(item, this.clock())) {
          this.#expireAuthorization(item);
          this.#touch(item, this.clock().toISOString(), previousStage);
          return;
        }
      }
      item.reviewProofs = { ...item.reviewProofs, ...reviewProofs };
      item.status = item.authorization ? "queued" : "preparing";
      item.stage = item.authorization ? "approval" : "edition";
      item.error = null; item.reviewPolling = null;
      this.#touch(item, this.clock().toISOString(), previousStage);
    });
    this.#schedule();
    return result;
  }

  async recover() {
    this.#recovery ??= this.#restoreInterruptedWork();
    await this.#recovery;
  }

  async #restoreInterruptedWork() {
    const state = this.#state();
    if ((state.revisionBatches ?? []).some(batch => batch.items.some(item => item.operation || item.status === "publishing"))) {
      await this.store.mutate({ type: "editorial.revision_batches_recovered", actor: "system", includeState: false }, next => {
        for (const batch of next.revisionBatches) {
          let changed = false;
          for (const item of batch.items) {
            if (item.operation) { item.operation = null; changed = true; }
            if (item.status === "publishing") { item.status = "queued"; changed = true; }
          }
          if (changed) { batch.revision++; batch.updatedAt = this.clock().toISOString(); }
        }
      });
    }
    this.#ready = true;
    this.#schedule();
  }

  async close() {
    this.#closed = true;
    clearTimeout(this.#reviewTimer);
    await this.#draining;
  }

  async idle() { await this.#draining; }

  #state() { return this.store.snapshot(STATE_FIELDS); }

  #schedule() {
    if (!this.autoRun || !this.#ready || this.#closed) return;
    this.#needsWake = true;
    if (this.#draining) return;
    this.#draining = Promise.resolve().then(async () => {
      while (this.#needsWake && !this.#closed) {
        this.#needsWake = false;
        await this.drain();
        if (!this.#closed) await this.#reconcilePendingReviews();
      }
      this.#workerFailure = null;
    }).catch(error => {
      this.#workerFailure = failure(error);
    }).finally(() => {
      this.#draining = null;
      if (this.#needsWake && !this.#workerFailure) this.#schedule();
      else if (!this.#closed && !this.#workerFailure) this.#armReviewTimer();
    });
  }

  #touch(item, now, previousStage) {
    item.updatedAt = now;
    item.elapsedMs = Math.max(0, Date.parse(now) - Date.parse(item.startedAt ?? now));
    if (previousStage !== undefined && previousStage !== item.stage) {
      const duration = Math.max(0, Date.parse(now) - Date.parse(item.stageStartedAt ?? item.startedAt ?? now));
      const times = item.stageDurationsMs ??= {};
      times[previousStage] = (times[previousStage] ?? 0) + duration;
      item.stageStartedAt = now;
    }
  }

  #expireAuthorization(item) {
    item.status = "ready"; item.stage = "authorization"; item.operation = null; item.reviewPolling = null;
    item.error = { code: "EDITORIAL_BATCH_AUTHORIZATION_EXPIRED", message: "批次授权已到期，核对后可重新授权此版本。" };
    item.authorization = null;
  }

  #pendingReviews() {
    return (this.#state().revisionBatches ?? []).flatMap(batch => batch.items
      .filter(item => item.status === "awaiting_review" && item.reviewPolling && item.expectedReview)
      .map(item => ({ batch, item })));
  }

  #armReviewTimer() {
    clearTimeout(this.#reviewTimer);
    if (!this.autoRun || this.#closed || typeof this.editorial.aiApproval?.inspectReview !== "function") return;
    const due = this.#pendingReviews().reduce((earliest, { item }) => Math.min(earliest, item.reviewPolling.nextAt), Infinity);
    if (Number.isFinite(due)) {
      this.#reviewTimer = setTimeout(() => this.#schedule(), Math.max(0, due - this.clock().getTime()));
      this.#reviewTimer.unref();
    }
  }

  async #reconcilePendingReviews() {
    const aiApproval = this.editorial.aiApproval;
    if (typeof aiApproval?.inspectReview !== "function") return;
    const now = this.clock();
    for (const { batch, item } of this.#pendingReviews()) {
      if (item.reviewPolling.nextAt > now.getTime()) continue;
      let status, error;
      if (!authorizationValid(item, now)) status = "expired";
      else {
        try { ({ status } = await aiApproval.inspectReview(item.expectedReview.reviewId)); }
        catch (caught) { status = "unresolved"; error = failure(caught); }
      }
      await this.#itemWrite(batch.id, item.id, "review_reconciled", current => {
        if (current.status !== "awaiting_review" || current.expectedReview?.reviewId !== item.expectedReview.reviewId) return false;
        if (status === "expired") this.#expireAuthorization(current);
        else if (status === "ready") {
          current.status = "queued"; current.reviewPolling = null;
          this.#needsWake = true;
        } else if (status === "unresolved") {
          current.reviewPolling = null;
          current.error = { ...current.error,
            ...(error ?? { code: "AI_APPROVAL_REVIEW_UNRESOLVED", message: "原审核结果未知，等待原工单对账。" }) };
        } else {
          const poll = current.reviewPolling.number + 1;
          current.reviewPolling = poll >= REVIEW_MAX_POLLS ? null
            : { number: poll, nextAt: now.getTime() + Math.min(60_000, 5000 * 2 ** poll) };
        }
      });
    }
  }

  #checkDestination(state, id) {
    const destination = state.destinations.find(row => row.id === id);
    if (!destination || destination.kind !== "owned_origin" || destination.platformId !== "official-site" ||
        destination.status !== "active" || destination.identityReview?.status !== "verified" ||
        destination.policyStatus !== "reviewed" || destination.visibility !== "public" ||
        destination.locator?.origin !== this.editorial.publicOrigin) {
      fail(409, "OWNED_PUBLIC_DESTINATION_REQUIRED", "仅支持已核验并授权的本人官网公开目的地。");
    }
  }

  #preflightItem(state, draft, existing = null) {
    let baseEditionId = existing?.baseEditionId ?? null;
    let previousContentId = existing?.previousContentId ?? null;
    try {
      const { release } = currentBase(state, draft);
      if (!baseEditionId) baseEditionId = latestEdition(state, draft)?.id ?? null;
      if (!previousContentId) previousContentId = release.contentId;
      if (draft.expectedPublicSnapshotHash) this.#expectedPublic(draft);
      for (const claimId of draft.claimIds) {
        if (!state.claims.some(row => row.id === claimId)) fail(409, "EDITORIAL_BATCH_CLAIM_MISSING", "有事实引用不存在。");
      }
      if (draft.illustrationPlanId) this.#checkPlan(this.editorial.getArticleIllustrations(draft.storyId, draft.illustrationPlanId), draft);
      else if (draft.illustrationPolicy !== REVISION_BATCH_DIAGRAM_POLICY || draft.illustrations.length !== 2 ||
          !["architecture", "logic"].every(kind => draft.illustrations.some(entry => entry.kind === kind))) {
        fail(409, "EDITORIAL_BATCH_PLAN_REQUIRED", "含场景图的稿件需要指定已完成签章和审核的原稿配图计划。");
      }
      for (const ref of draft.illustrations) {
        const asset = state.mediaAssets.find(media => media.id === ref.assetId);
        if (!asset || asset.kind !== "image" || asset.sha256 !== ref.sha256 || asset.status !== "reviewed" ||
            asset.review?.sha256 !== ref.sha256 || asset.review.rightsConfirmed !== true || asset.review.privacyConfirmed !== true) {
          fail(409, "ILLUSTRATION_ASSET_NOT_REVIEWED", "有图片未通过版权与隐私审核，或文件摘要已变化。");
        }
      }
      return { canonicalPath: draft.canonicalPath, baseEditionId, previousContentId, error: null };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return { canonicalPath: draft.canonicalPath, baseEditionId, previousContentId, error: failure(error) };
    }
  }

  #checkPlan(plan, draft) {
    const slotsByAsset = new Map(plan.slots.map(slot => [slot.evidence?.assetId, slot]));
    if (plan.baseReleaseId !== undefined || plan.locale !== draft.locale || !plan.isComplete ||
        plan.sourceHash !== articleIllustrationSourceHash(draft) ||
        (plan.illustrationPolicy ?? null) !== draft.illustrationPolicy ||
        (draft.illustrations.length && (plan.slots.length !== draft.illustrations.length || draft.illustrations.some(image => {
          const slot = slotsByAsset.get(image.assetId);
          return !slot || ["kind", "anchor", "description", "alt", "caption"].some(field => slot[field] !== image[field]) ||
            slot.evidence.sha256 !== image.sha256;
        })))) {
      fail(409, "EDITORIAL_BATCH_PLAN_MISMATCH", "指定配图计划必须属于同一选题和准确新稿，且所有图位已完成。");
    }
    return slotsByAsset;
  }

  #expectedPublic(draft) {
    if (!this.#publicReadModel) {
      this.#publicReadModel = createPublicArticleOverlay({ editorial: this.editorial, mediaAssets: this.mediaAssets,
        articleOverlayDirectory: this.overlayDirectory })?.editorial ?? this.editorial;
    }
    const visible = this.#publicReadModel.publicDetail({ locale: draft.locale, format: "article", slug: draft.slug });
    if (visible.releaseId !== draft.baseReleaseId || visible.snapshotHash !== draft.expectedPublicSnapshotHash) {
      fail(409, "EDITORIAL_BATCH_PUBLIC_BASE_CHANGED", "实际公开稿件的快照已变化，须重新核对接管范围。");
    }
    return visible;
  }

  async #editorWrite(id, action, input, ctx, update) {
    const identity = writeIdentity(input, `${id}:${action}`, ctx);
    const { result } = await this.store.mutate({ type: `editorial.revision_batch_${action.split(":")[0]}`,
      actor: identity.actor, payload: { batchId: id, requestHash: identity.requestHash }, includeState: false }, state => {
      const batch = findBatch(state, id);
      const prior = batch.requests.find(entry => entry.keyHash === identity.keyHash);
      if (prior) {
        if (prior.requestHash !== identity.requestHash) fail(409, "IDEMPOTENCY_CONFLICT", "此幂等键已用于不同请求。");
        return JsonStore.noChange(batchView(batch));
      }
      if (ctx.ifMatch !== batchEtag(batch)) fail(412, "EDITORIAL_BATCH_ETAG_MISMATCH", "批次刚刚更新，请刷新后确认。");
      const now = this.clock().toISOString();
      update(state, batch, identity.actor, now);
      batch.requests.push({ keyHash: identity.keyHash, requestHash: identity.requestHash });
      batch.updatedAt = now; batch.revision++;
      return batchView(batch);
    });
    return result;
  }

  async #itemWrite(batchId, itemId, stage, update) {
    const { result } = await this.store.mutate({ type: `editorial.revision_batch_${stage}`, actor: "revision-batch-worker",
      payload: { batchId, itemId }, includeState: false }, state => {
      const batch = findBatch(state, batchId);
      const item = findItem(batch, itemId);
      const previousStage = item.stage;
      if (item.status === "rolled_back" || update(item, batch) === false) return JsonStore.noChange(item);
      batch.updatedAt = this.clock().toISOString(); batch.revision++;
      this.#touch(item, batch.updatedAt, previousStage);
      return { ...item };
    });
    return result;
  }

  async #action(batch, item, kind, scope, input, ifMatch, invoke) {
    const actor = kind === "prepare" ? batch.createdBy
      : kind === "workflow" ? item.workflowAuthorization.actor : item.authorization.actor;
    const operation = { token: randomUUID(), actor, kind, scope, inputHash: hashObject(input), ifMatch,
      editionId: item.editionId, releaseId: item.releaseId };
    const started = await this.#itemWrite(batch.id, item.id, "step_started", current => { current.operation = operation; });
    if (started.operation?.token !== operation.token) {
      fail(409, "EDITORIAL_BATCH_EXECUTION_CANCELLED", "此文章批次执行权已失效。");
    }
    try {
      return await invoke({ actor, ifMatch, method: "editorial-batch", batchId: batch.id, itemId: item.id,
        operationToken: operation.token, idempotencyKey: stepKey(batch.id, item.id, scope, input),
        ...(kind === "workflow" && item.expectedReview ? { expectedReview: item.expectedReview } : {}) });
    } finally {
      await this.#itemWrite(batch.id, item.id, "step_finished", current => {
        if (current.operation?.token !== operation.token) return false;
        current.operation = null;
      });
    }
  }

  async #error(batch, item, error, stage) {
    const record = failure(error);
    await this.#itemWrite(batch.id, item.id, "item_failed", current => {
      if (record.code === "EDITORIAL_BATCH_AUTHORIZATION_EXPIRED" ||
          stage !== "readback" && current.authorization && !authorizationValid(current, this.clock())) {
        this.#expireAuthorization(current);
        return;
      }
      current.status = REVIEW_CODES.has(record.code) ? "awaiting_review" : "failed";
      current.error = record; current.stage = stage; current.operation = null;
      if (typeof error?.details?.workflow?.releaseId === "string") current.releaseId = error.details.workflow.releaseId;
      if (record.proofKey && record.reviewId) current.expectedReview = { proofKey: record.proofKey, reviewId: record.reviewId };
      if (record.code === "AI_APPROVAL_PENDING" && record.proofKey && record.reviewId) {
        current.reviewPolling = { number: 0, nextAt: this.clock().getTime() + 5000 };
      }
    });
  }

  async #prepareItem(batch, item) {
    const draft = item.draft;
    try {
      currentBase(this.#state(), draft);
      const story = this.editorial.getStory(draft.storyId);
      let plan;
      if (item.planId) plan = this.editorial.getArticleIllustrations(draft.storyId, item.planId);
      else {
        const slots = draft.illustrations.map(({ kind, anchor, description, alt, caption }) =>
          ({ kind, anchor, description, alt, caption }));
        const input = { locale: draft.locale, articleType: draft.articleType ?? "product",
          title: draft.title, summary: draft.summary, body: draft.body, illustrationPolicy: draft.illustrationPolicy, slots };
        plan = await this.#action(batch, item, "prepare", `illustration_plan_created:${draft.storyId}`, input, story.etag,
          ctx => this.editorial.createArticleIllustrations(draft.storyId, input, ctx));
        await this.#itemWrite(batch.id, item.id, "plan_prepared", current => { current.planId = plan.id; });
        plan = this.editorial.getArticleIllustrations(draft.storyId, plan.id);
      }
      if (!draft.illustrationPlanId) {
        for (const [index, ref] of draft.illustrations.entries()) {
          const slot = plan.slots[index];
          if (slot.evidence?.assetId === ref.assetId && slot.evidence.sha256 === ref.sha256) continue;
          if (slot.evidence) fail(409, "EDITORIAL_BATCH_PLAN_MISMATCH", "已有图位的素材与冻结导入不同。");
          const input = { slotId: slot.id, assetId: ref.assetId, sha256: ref.sha256 };
          await this.#action(batch, item, "prepare", `illustration_bound:${plan.id}:${slot.id}`, input, plan.etag,
            ctx => this.editorial.bindArticleIllustration(draft.storyId, plan.id, input, ctx));
          plan = this.editorial.getArticleIllustrations(draft.storyId, plan.id);
        }
      }
      const slotsByAsset = this.#checkPlan(plan, draft);
      const placementPlan = draft.expectedPublicSnapshotHash && draft.illustrations.length
        ? { ...plan, slots: draft.illustrations.map(image => slotsByAsset.get(image.assetId)) } : plan;
      const { blocks, assetRefs } = placeArticleIllustrations(placementPlan, draft);
      const input = { locale: draft.locale, format: "article", title: draft.title, summary: draft.summary, body: draft.body,
        blocks, assetRefs, claimIds: draft.claimIds, illustrationPlanId: plan.id,
        ...(item.baseEditionId ? { supersedesEditionId: item.baseEditionId } : {}) };
      const scope = `edition_created:${draft.storyId}`;
      const state = this.#state();
      currentBase(state, draft);
      const keyHash = hashObject({ actor: batch.createdBy, scope, key: stepKey(batch.id, item.id, scope, input) });
      const replay = state.editorialRequests?.find(request => request.keyHash === keyHash);
      if (!replay && (latestEdition(state, draft)?.id ?? null) !== item.baseEditionId) {
        fail(409, "EDITORIAL_BATCH_EDITION_CHANGED", "原文章母稿已发生改动，请重新导入。");
      }
      const edition = await this.#action(batch, item, "prepare", scope, input, this.editorial.getStory(draft.storyId).etag,
        ctx => this.editorial.createEdition(draft.storyId, input, ctx));
      if (edition.title !== draft.title || edition.summary !== draft.summary || edition.body !== draft.body ||
          hashObject(edition.blocks) !== hashObject(blocks) || hashObject(edition.claimIds) !== hashObject(draft.claimIds)) {
        fail(409, "EDITORIAL_BATCH_PREPARED_COPY_CHANGED", "保存母稿时正文或配图发生了确定性转换，请核对后重新导入。");
      }
      await this.#itemWrite(batch.id, item.id, "edition_prepared", current => {
        current.editionId = edition.id; current.editionSnapshotHash = edition.snapshotHash;
        current.status = "ready"; current.stage = "authorization"; current.error = null;
      });
    } catch (error) {
      await this.#error(batch, item, error, "edition");
    }
  }

  #workflowInput(batch, item) {
    return { destinationId: batch.destinationId, slug: item.draft.slug,
      editionSnapshotHash: item.authorization.editionSnapshotHash, expectedPreviousReleaseId: item.draft.baseReleaseId,
      ...(item.previousContentId ? { supersedesContentId: item.previousContentId } : {}),
      publicationAuthorized: true, authorizationNote: item.workflowAuthorization.note };
  }

  #checkPublication(state, batch, item) {
    this.#checkDestination(state, batch.destinationId);
    if (!item.authorization || item.authorization.editionSnapshotHash !== item.editionSnapshotHash) {
      fail(409, "EDITORIAL_BATCH_EDITION_CHANGED", "准备发布的母稿与批准版本不符。");
    }
    if (!authorizationValid(item, this.clock())) {
      fail(409, "EDITORIAL_BATCH_AUTHORIZATION_EXPIRED", "发布授权已经到期。");
    }
    const edition = latestEdition(state, item.draft);
    if (edition?.id !== item.editionId || edition.snapshotHash !== item.authorization.editionSnapshotHash) {
      fail(409, "EDITORIAL_BATCH_EDITION_CHANGED", "该文章已有更新母稿，请重新核对发布范围。");
    }
    currentBase(state, item.draft);
    return edition;
  }

  async #preparePublication(batch, item) {
    try {
      const state = this.#state();
      const knownRelease = state.websiteReleases.find(row => row.id === item.releaseId && row.editionId === item.editionId);
      const active = state.websiteRoutes.find(row => row.canonicalPath === item.draft.canonicalPath);
      item = await this.#itemWrite(batch.id, item.id, "publishing", current => {
        current.status = "publishing"; current.stage = "approval";
        if (!current.workflowAuthorization && authorizationValid(current, this.clock())) {
          const { actor, note, editionSnapshotHash } = current.authorization;
          current.workflowAuthorization = { actor, note, editionSnapshotHash };
        }
      });
      if (knownRelease?.id === active?.activeReleaseId && knownRelease &&
          ["published", "live_unverified"].includes(knownRelease.status)) {
        await this.#verifyPublication(batch, item);
        return null;
      }
      this.#checkPublication(state, batch, item);
      const liveProjection = item.draft.expectedPublicSnapshotHash ? this.#expectedPublic(item.draft) : null;
      const edition = this.editorial.getEdition(item.editionId);
      const input = this.#workflowInput(batch, item);
      const prepared = await this.#action(batch, item, "workflow", `website_ai_authorized:${edition.id}`, input, edition.etag,
        ctx => this.editorial.prepareRevisionBatchEdition(edition.id, { ...input, reviewProofs: item.reviewProofs }, ctx));
      const release = this.editorial.getRelease(prepared.releaseId);
      if (release.editionId !== edition.id || release.canonicalPath !== item.draft.canonicalPath ||
          release.previousReleaseId !== item.draft.baseReleaseId || release.status !== "approved") {
        fail(409, "EDITORIAL_BATCH_RELEASE_NOT_READY", "发布候选尚未获得与当前文章对应的审批。");
      }
      if (liveProjection) {
        assertArticleTakeoverParity(liveProjection, this.editorial.previewRelease(release.id));
      }
      return await this.#itemWrite(batch.id, item.id, "release_prepared", current => {
        current.releaseId = release.id; current.stage = "activation"; current.error = null;
      });
    } catch (error) {
      await this.#error(batch, item, error, "approval");
      return null;
    }
  }

  async #verifyPublication(batch, item) {
    try {
      const activeRoute = this.#state().websiteRoutes.find(row => row.canonicalPath === item.draft.canonicalPath);
      let release = this.editorial.getRelease(item.releaseId);
      if (activeRoute?.activeReleaseId !== release.id || release.editionId !== item.editionId) {
        fail(409, "EDITORIAL_BATCH_RELEASE_NOT_CURRENT", "该地址当前未指向此批次批准的发布版本。");
      }
      if (release.status === "live_unverified") {
        const input = { confirm: true };
        try {
          await this.#action(batch, item, "readback", `release_verified:${release.id}`, input, release.etag,
            ctx => this.editorial.verifyRelease(release.id, input, ctx));
        } catch (error) {
          release = this.editorial.getRelease(item.releaseId);
          if (release.status !== "published" || release.receipt?.dataMode !== "real") throw error;
        }
        release = this.editorial.getRelease(item.releaseId);
      }
      if (release.status !== "published" || release.receipt?.dataMode !== "real" ||
          release.receipt.releaseId !== release.id || release.receipt.snapshotHash !== release.snapshotHash ||
          this.#state().websiteRoutes.find(row => row.canonicalPath === item.draft.canonicalPath)?.activeReleaseId !== release.id) {
        fail(409, "EDITORIAL_BATCH_READBACK_REQUIRED", "此版本尚无与活动发布一致的真实公网回执。");
      }
      await this.#itemWrite(batch.id, item.id, "published", current => {
        current.status = "published"; current.stage = "readback"; current.error = null;
        current.receipt = release.receipt;
      });
    } catch (error) {
      await this.#error(batch, item, error, "readback");
    }
  }

  async #activateGroup(batch, items) {
    const eligible = [];
    for (const item of items) {
      try {
        const release = this.editorial.getRelease(item.releaseId);
        this.#checkPublication(this.#state(), batch, item);
        if (release.status !== "approved") fail(409, "EDITORIAL_BATCH_RELEASE_NOT_READY", "候选审核状态已变化。");
        if (item.draft.expectedPublicSnapshotHash) {
          assertArticleTakeoverParity(this.#expectedPublic(item.draft), this.editorial.previewRelease(release.id));
        }
        const actor = item.authorization.actor;
        const scope = `release_activated:${release.id}`;
        const input = { confirm: true, expectedPreviousReleaseId: item.draft.baseReleaseId };
        const operation = { token: randomUUID(), actor, kind: "activate", scope, inputHash: hashObject(input),
          ifMatch: release.etag, editionId: item.editionId, releaseId: item.releaseId };
        const started = await this.#itemWrite(batch.id, item.id, "activation_started", current => { current.operation = operation; });
        if (started.operation?.token !== operation.token) {
          fail(409, "EDITORIAL_BATCH_EXECUTION_CANCELLED", "此文章批次执行权已失效。");
        }
        const ctx = { actor, ifMatch: release.etag, method: "editorial-batch", batchId: batch.id, itemId: item.id,
          operationToken: operation.token, idempotencyKey: stepKey(batch.id, item.id, scope, input) };
        eligible.push({ item, entry: { releaseId: item.releaseId, expectedPreviousReleaseId: item.draft.baseReleaseId, ctx } });
      } catch (error) {
        await this.#error(batch, item, error, "activation");
      }
    }
    if (!eligible.length) return;

    let groupError = null;
    try {
      await this.editorial.activateRevisionBatchGroup(eligible.map(({ entry }) => entry));
    } catch (error) {
      groupError = error;
    }
    const retryOthers = [];
    for (const { item, entry } of eligible) {
      const next = await this.#itemWrite(batch.id, item.id, "activation_finished", current => {
        if (current.operation?.token !== entry.ctx.operationToken) return false;
        current.operation = null;
      });
      if (next.status === "rolled_back") continue;
      const current = this.#state().websiteRoutes.find(row => row.canonicalPath === item.draft.canonicalPath);
      if (current?.activeReleaseId === item.releaseId) {
        await this.#verifyPublication(batch, next);
      } else if (groupError?.details?.releaseId && groupError.details.releaseId !== item.releaseId &&
          eligible.some(({ item: member }) => member.releaseId === groupError.details.releaseId)) {
        retryOthers.push(next);
      } else {
        await this.#error(batch, next, groupError ?? new ApiError(409, "EDITORIAL_BATCH_ACTIVATION_NOT_CONFIRMED",
          "激活未成功，原公开版本已保留。"), "activation");
      }
    }
    if (retryOthers.length) await this.#activateGroup(batch, retryOthers);
  }

  async drain() {
    while (!this.#closed) {
      const batches = this.#state().revisionBatches ?? [];
      const publishBatch = batches.find(batch => batch.items.some(item => item.status === "queued"));
      if (publishBatch) {
        const prepared = [];
        const items = publishBatch.items.filter(item => item.status === "queued").slice(0, PUBLISH_GROUP_SIZE);
        for (const item of items) {
          const ready = await this.#preparePublication(publishBatch, item);
          if (ready) prepared.push(ready);
        }
        if (prepared.length) await this.#activateGroup(publishBatch, prepared);
        continue;
      }
      const prepareBatch = batches.find(batch => batch.items.some(item => item.status === "preparing"));
      if (!prepareBatch) return;
      await this.#prepareItem(prepareBatch, prepareBatch.items.find(item => item.status === "preparing"));
    }
  }
}
