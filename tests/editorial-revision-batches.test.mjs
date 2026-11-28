import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApiError } from "../src/domain/errors.mjs";
import { hashObject } from "../src/domain/hash.mjs";
import { routeEditorialApi } from "../src/http/editorial-routes.mjs";
import { aiApprovalWorkOrder, createAiApproval } from "../src/services/ai-approval.mjs";
import { EditorialRevisionBatchService } from "../src/services/editorial-revision-batches.mjs";
import { activateRelease, approvedRelease, clock, context, createEditionVariant, editorialFixture, readyWebsite } from "./editorial-fixtures.mjs";
import { syntheticIllustrationPng, uploadFixtureIllustration } from "./fixtures/article-illustrations.mjs";

const origin = "https://pengmanager.com";
const text = "流程架构说明各角色的工作边界。\n\n执行顺序包含输入校验和错误修正。";
const blocks = text.split("\n\n").map(value => ({ type: "paragraph", text: value }));
const review = input => ({ schema: "pengmanager.ai-approval/v1", kind: input.kind, subjectId: input.subjectId,
  snapshotHash: input.snapshotHash, decision: "approve", actor: "ai-reviewer", reviewedAt: new Date().toISOString(),
  evidenceHash: hashObject(input.evidence), rationale: "Isolated reviewer fixture", modelReceipt: { responseId: "test-batch-review" } });

async function livePrior(f, slug) {
  const { story, variant } = await createEditionVariant(f);
  const approved = await approvedRelease(f, variant, slug);
  const live = await activateRelease(f, approved);
  const released = await f.service.verifyRelease(live.id, { confirm: true }, context(live));
  return { story, released };
}

async function setup(t, count = 1, batchClock = clock) {
  const f = await editorialFixture(t);
  await readyWebsite(f);
  const items = [];
  for (let index = 0; index < count; index++) {
    const { story, released } = await livePrior(f, `revision-sample-${index + 1}`);
    const assets = [];
    for (let offset = 0; offset < 2; offset++) {
      assets.push(await uploadFixtureIllustration(f.mediaAssets, await syntheticIllustrationPng(7 + index * 2 + offset)));
    }
    items.push({ storyId: story.id, canonicalPath: released.canonicalPath,
      baseReleaseId: released.id, baseSnapshotHash: released.snapshotHash,
      title: `正式文章修订样本 ${index + 1}`, summary: "可读的修订摘要。", body: text, blocks: structuredClone(blocks), claimIds: ["C003"],
      articleType: "product", illustrationPolicy: "diagram-pair-v1", illustrations: [
        { kind: "architecture", anchor: "流程架构说明", description: "流程角色边界", alt: "显示架构与边界", caption: "架构各部分",
          assetId: assets[0].id, sha256: assets[0].sha256 },
        { kind: "logic", anchor: "执行顺序包含", description: "执行步骤与错误处理", alt: "显示执行逻辑", caption: "执行顺序",
          assetId: assets[1].id, sha256: assets[1].sha256 },
      ] });
  }
  const groups = [], reviews = [];
  f.service.aiApproval = { async review(input) { reviews.push(input); return review(input); } };
  f.service.mediaAssets = f.mediaAssets;
  f.service.validateRevisionBatchExecution = (state, ctx, scope, input) =>
    EditorialRevisionBatchService.validateExecution(state, ctx, scope, input, batchClock());
  f.service.beforeActivation.captureBatchCommitted = async (candidates, state) => {
    groups.push(structuredClone(candidates));
    return { backupId: `EDB-${"e".repeat(32)}`, stage: "pre_batch_activation", candidates,
      manifestSha256: "e".repeat(64), stateSha256: "f".repeat(64), assetCount: state.mediaAssets.length,
      totalBytes: 100, createdAt: new Date("2026-10-25T10:00:00.000Z").toISOString() };
  };
  const service = new EditorialRevisionBatchService({ store: f.store, editorial: f.service, mediaAssets: f.mediaAssets, clock: batchClock, autoRun: false });
  return { ...f, batch: service, input: { destinationId: "official-site", items }, groups, reviews };
}

function authorization(batch) {
  return { manifestHash: batch.manifestHash, items: batch.items.filter(row => row.status === "ready")
    .map(row => ({ id: row.id, editionSnapshotHash: row.editionSnapshotHash })),
  authorizationNote: "本人审核这些冻结版本，按原网址发布到实际官网。" };
}

test("preflight is read-only, creation is idempotent, and authorization publishes two distinct canonical routes in one backup", async t => {
  const f = await setup(t, 2);
  const createCtx = context();
  const revision = f.store.snapshot().revision;
  const preflight = f.batch.preflight(f.input, createCtx);
  assert.equal(preflight.items.filter(row => row.error).length, 0);
  assert.equal(f.store.snapshot().revision, revision);
  const imported = await f.batch.create(f.input, createCtx);
  const duplicate = await f.batch.create(f.input, createCtx);
  assert.equal(imported.id, duplicate.id);
  await assert.rejects(f.batch.create({ ...f.input, items: f.input.items.slice(0, 1) }, createCtx), { code: "IDEMPOTENCY_CONFLICT" });
  assert.equal(imported.manifestHash, preflight.manifestHash);
  const secondPage = f.batch.get(imported.id, createCtx, { offset: 1, limit: 1 });
  assert.equal(secondPage.etag, imported.etag);
  assert.deepEqual(secondPage.items.map(item => item.id), ["item-2"]);
  assert.deepEqual(secondPage.page, { offset: 1, limit: 1, total: 2 });
  assert.equal(Object.values(secondPage.counts).reduce((sum, amount) => sum + amount, 0), 2);
  await f.batch.drain();
  const prepared = f.batch.get(imported.id, createCtx);
  assert.deepEqual(prepared.items.map(row => row.status), ["ready", "ready"]);
  assert.deepEqual(f.groups, []);
  assert.ok(!JSON.stringify(prepared).includes("operationToken"));
  const auth = authorization(prepared);
  await assert.rejects(f.batch.authorize(imported.id, auth, context(imported)), { code: "EDITORIAL_BATCH_ETAG_MISMATCH" });
  const mismatched = { ...auth, items: [{ ...auth.items[0], editionSnapshotHash: "0".repeat(64) }] };
  await assert.rejects(f.batch.authorize(imported.id, mismatched, context(prepared)), { code: "EDITORIAL_BATCH_EDITION_CHANGED" });
  const authCtx = context(prepared);
  await f.batch.authorize(imported.id, auth, authCtx);
  await f.batch.authorize(imported.id, auth, authCtx);
  await f.batch.drain();
  const result = f.batch.get(imported.id, createCtx);
  assert.deepEqual(result.items.map(row => [row.status, row.receipt?.dataMode, row.error]), [
    ["published", "real", null], ["published", "real", null],
  ]);
  assert.equal(f.groups.length, 1);
  assert.equal(f.groups[0].length, 2);
  for (const [index, item] of result.items.entries()) {
    const detail = f.service.publicDetail({ locale: "zh-CN", format: "article", slug: `revision-sample-${index + 1}` });
    assert.equal(detail.releaseId, item.releaseId);
    assert.equal(detail.body, text);
    assert.deepEqual(detail.assets.map(asset => asset.sha256), f.input.items[index].illustrations.map(asset => asset.sha256));
  }
  assert.equal(f.store.snapshot().revisionBatches[0].items.every(row => row.operation === null), true);
});

test("unapproved media blocks only its row, and a failed readback resumes the actual active release without repeating review or activation", async t => {
  const f = await setup(t, 2);
  f.input.items[1].illustrations[0].sha256 = "e".repeat(64);
  const createCtx = context();
  const imported = await f.batch.create(f.input, createCtx);
  assert.equal(imported.items[1].status, "blocked");
  assert.equal(imported.items[1].error.code, "ILLUSTRATION_ASSET_NOT_REVIEWED");
  await f.batch.drain();
  const prepared = f.batch.get(imported.id, createCtx);
  assert.deepEqual(prepared.items.map(row => row.status), ["ready", "blocked"]);

  const originalReadback = f.service.verifyReadback;
  f.service.verifyReadback = async () => { throw new ApiError(503, "WEBSITE_READBACK_UNAVAILABLE", "隔离测试短暂网络错误。"); };
  await f.batch.authorize(imported.id, authorization(prepared), context(prepared));
  await f.batch.drain();
  const interrupted = f.batch.get(imported.id, createCtx);
  assert.equal(interrupted.items[0].status, "failed");
  assert.equal(interrupted.items[0].stage, "readback");
  const releaseId = interrupted.items[0].releaseId;
  assert.equal(f.service.getRelease(releaseId).status, "live_unverified");
  const initialReviewCount = f.reviews.length;

  f.service.verifyReadback = originalReadback;
  const rebuilt = new EditorialRevisionBatchService({ store: f.store, editorial: f.service, mediaAssets: f.mediaAssets, clock });
  const retryCtx = context(interrupted);
  await rebuilt.retry(imported.id, "item-1", {}, retryCtx);
  assert.equal(rebuilt.get(imported.id, createCtx).items[0].status, "queued");
  await rebuilt.recover();
  await rebuilt.idle();
  const finished = rebuilt.get(imported.id, createCtx);
  assert.deepEqual(finished.items.map(row => row.status), ["published", "blocked"]);
  assert.equal(finished.items[0].releaseId, releaseId);
  assert.equal(f.groups.length, 1);
  assert.equal(f.reviews.length, initialReviewCount);
  await rebuilt.close();
});

test("takeover preserves public asset order when the existing signed plan has a different slot order", async t => {
  const f = await setup(t);
  const original = await f.batch.create(f.input, context());
  await f.batch.drain();
  const firstPrepared = f.batch.get(original.id, context());
  await f.batch.authorize(original.id, authorization(firstPrepared), context(firstPrepared));
  await f.batch.drain();
  const first = f.batch.get(original.id, context()).items[0];
  assert.equal(first.status, "published");
  const draft = f.input.items[0];
  const edition = f.service.getEdition(first.editionId);
  const live = f.service.publicDetail({ locale: "zh-CN", format: "article", slug: "revision-sample-1" });
  const legacyIds = new Map(live.assets.map(asset => [asset.assetId, `overlay-${asset.sha256}`]));
  const expectedPublicSnapshotHash = "a".repeat(64);
  const projected = { ...live, snapshotHash: expectedPublicSnapshotHash,
    assets: live.assets.toReversed().map(asset => ({ ...asset, assetId: legacyIds.get(asset.assetId) })),
    blocks: live.blocks.map(block => block.type === "image" ? { ...block, assetId: legacyIds.get(block.assetId) } : block) };
  f.service.projectPublicArticle = article => article.releaseId === first.releaseId ? projected : article;
  const takeover = new EditorialRevisionBatchService({ store: f.store, editorial: f.service, mediaAssets: f.mediaAssets, clock,
    publicEditorial: { publicDetail: () => projected }, autoRun: false });
  const input = { ...f.input, items: [{ ...draft, baseReleaseId: live.releaseId, baseSnapshotHash: live.snapshotHash,
    expectedPublicSnapshotHash, illustrationPlanId: edition.illustrationPlanId, illustrations: draft.illustrations.toReversed() }] };
  assert.equal(takeover.preflight(input, context()).items[0].error, null);
  const imported = await takeover.create(input, context());
  await takeover.drain();
  const prepared = takeover.get(imported.id, context());
  assert.equal(prepared.items[0].status, "ready", JSON.stringify(prepared.items[0].error));
  await takeover.authorize(imported.id, authorization(prepared), context(prepared));
  await takeover.drain();
  const finished = takeover.get(imported.id, context()).items[0];
  assert.equal(finished.status, "published", JSON.stringify(finished.error));
  const result = f.service.publicDetail({ locale: "zh-CN", format: "article", slug: "revision-sample-1" });
  assert.deepEqual(result.assets.map(asset => asset.sha256), projected.assets.map(asset => asset.sha256));
  assert.deepEqual(result.blocks, live.blocks);
  for (const asset of result.assets) {
    assert.equal(f.service.publicArticleMediaAlias(`overlay-${asset.sha256}`, asset.sha256)?.assetId, asset.assetId);
  }

  const release = f.service.getRelease(finished.releaseId);
  const rollback = { expectedPreviousReleaseId: first.releaseId, reason: "Restore the exact earlier public projection." };
  await assert.rejects(f.service.rollbackRelease(release.id, rollback, context(release)), {
    code: "ARTICLE_TAKEOVER_ROLLBACK_BUNDLE_REQUIRED",
  });
  assert.equal(f.service.publicDetail({ locale: "zh-CN", format: "article", slug: "revision-sample-1" }).releaseId, release.id);
  f.service.verifyRollbackProjection = async earlier => earlier.snapshotHash === projected.snapshotHash;
  const restored = await f.service.rollbackRelease(release.id, rollback, context(release));
  assert.equal(restored.restoredReleaseId, first.releaseId);
  assert.equal(takeover.get(imported.id, context()).items[0].status, "rolled_back");
});

test("the admin batch routes return guarded preflight or reject a restricted agent before invoking the batch service", async () => {
  const output = [];
  const request = { method: "POST", headers: { "idempotency-key": "test-import" } };
  const invoke = (method, path) => routeEditorialApi({ request, response: {}, url: new URL(path, origin),
    principal: { method, actor: "actor" }, editorial: {}, revisionBatches: { preflight: input => ({ seen: input, etag: '"fixture"' }) },
    readJsonBody: async () => ({ received: true }), writeJson: (_response, status, body, headers) => output.push({ status, body, headers }) });
  await assert.rejects(invoke("agent", "/api/editorial/revision-batches/preflight"), { code: "AGENT_SCOPE_DENIED" });
  assert.equal(await invoke("session", "/api/editorial/revision-batches/preflight"), true);
  assert.deepEqual(output, [{ status: 200, body: { seen: { received: true }, etag: '"fixture"' }, headers: { ETag: '"fixture"' } }]);
  await assert.rejects(invoke("session", "/api/editorial/revision-batches/unknown/action"), { code: "EDITORIAL_REVISION_BATCH_ROUTE_NOT_FOUND" });
  request.method = "GET";
  const paged = path => routeEditorialApi({ request, response: {}, url: new URL(path, origin),
    principal: { method: "session", actor: "actor" }, editorial: {},
    revisionBatches: { get: (_id, _ctx, page) => page },
    writeJson: (_response, _status, body) => output.push(body) });
  await paged("/api/editorial/revision-batches/ERB-example?offset=20&limit=10");
  assert.deepEqual(output.at(-1), { offset: 20, limit: 10 });
  await assert.rejects(paged("/api/editorial/revision-batches/ERB-example?limit=101"), { code: "EDITORIAL_QUERY_INVALID" });
  await assert.rejects(paged("/api/editorial/revision-batches/ERB-example?offset=0&offset=1"), { code: "EDITORIAL_QUERY_INVALID" });
});

test("an expired grant returns the same prepared edition for explicit reauthorization before any review or activation", async t => {
  let now = clock();
  const f = await setup(t, 1, () => new Date(now));
  const contextForRead = context();
  const imported = await f.batch.create(f.input, contextForRead);
  await f.batch.drain();
  const prepared = f.batch.get(imported.id, contextForRead);
  await f.batch.authorize(imported.id, authorization(prepared), context(prepared));
  now = new Date(now.getTime() + 24 * 60 * 60 * 1000 + 1);
  await f.batch.drain();
  const expired = f.batch.get(imported.id, contextForRead);
  assert.equal(expired.items[0].status, "ready");
  assert.equal(expired.items[0].editionId, prepared.items[0].editionId);
  assert.equal(expired.items[0].error.code, "EDITORIAL_BATCH_AUTHORIZATION_EXPIRED");
  assert.equal(expired.items[0].authorizedAt, null);
  assert.equal(f.reviews.length, 0);
  assert.equal(f.groups.length, 0);
  await f.batch.authorize(imported.id, authorization(expired), context(expired));
  await f.batch.drain();
  const renewed = f.batch.get(imported.id, contextForRead);
  assert.equal(renewed.items[0].status, "published", JSON.stringify(renewed.items[0].error));
});

test("startup reconciles the original pending review ID once its durable result is ready", async t => {
  let now = clock();
  const batchClock = () => new Date(now);
  const f = await setup(t, 1, batchClock);
  const contextForRead = context();
  const reviewId = "d".repeat(64);
  const inspected = [], reviewRequests = [];
  f.service.aiApproval = {
    async inspectReview(id) { inspected.push(id); return { status: "ready", reviewId: id }; },
    async review(input) {
      reviewRequests.push({ kind: input.kind, expected: input.expectedReviewId });
      if (reviewRequests.length === 1) throw new ApiError(409, "AI_APPROVAL_PENDING", "隔离审核待签章。", { reviewId });
      return review(input);
    },
  };
  const imported = await f.batch.create(f.input, contextForRead);
  await f.batch.drain();
  const prepared = f.batch.get(imported.id, contextForRead);
  await f.batch.authorize(imported.id, authorization(prepared), context(prepared));
  await f.batch.drain();
  const pending = f.batch.get(imported.id, contextForRead);
  assert.equal(pending.items[0].status, "awaiting_review");
  assert.equal(pending.items[0].error.reviewId, reviewId);

  now = new Date(now.getTime() + 5000);
  const restarted = new EditorialRevisionBatchService({ store: f.store, editorial: f.service, mediaAssets: f.mediaAssets, clock: batchClock });
  t.after(() => restarted.close());
  await restarted.recover();
  await restarted.idle();
  const complete = restarted.get(imported.id, contextForRead);
  assert.equal(complete.items[0].status, "published", JSON.stringify(complete.items[0].error));
  assert.deepEqual(inspected, [reviewId]);
  assert.deepEqual(reviewRequests, [{ kind: "editorial.variant", expected: undefined },
    { kind: "editorial.variant", expected: reviewId }, { kind: "editorial.website_release", expected: undefined }]);
  assert.equal(f.groups.length, 1);
});

test("renewing an interrupted authorization preserves the original variant and review identity", async t => {
  let now = clock();
  const f = await setup(t, 1, () => new Date(now));
  const reviewId = "c".repeat(64);
  const reviewInputs = [];
  f.service.aiApproval = { async review(input) {
    reviewInputs.push(input);
    if (reviewInputs.length === 1) {
      throw new ApiError(409, "AI_APPROVAL_PENDING", "隔离审核等待原工单结果。", { reviewId });
    }
    return review(input);
  } };
  const imported = await f.batch.create(f.input, context());
  await f.batch.drain();
  const prepared = f.batch.get(imported.id, context());
  await f.batch.authorize(imported.id, authorization(prepared), context(prepared));
  await f.batch.drain();
  const pending = f.batch.get(imported.id, context());
  assert.equal(pending.items[0].status, "awaiting_review");
  const originalVariant = reviewInputs[0].subjectId;

  now = new Date(now.getTime() + 24 * 60 * 60 * 1000 + 1);
  await f.batch.retry(imported.id, "item-1", {}, context(pending));
  const expired = f.batch.get(imported.id, context());
  assert.equal(expired.items[0].status, "ready");
  const renewalActor = "renewing isolated unit reviewer";
  await f.batch.authorize(imported.id, { ...authorization(expired),
    authorizationNote: "再次核对相同的正文、配图和正式地址，授予准确版本的新发布期限。" },
  { ...context(expired), method: "session", actor: renewalActor });
  await f.batch.drain();

  const finished = f.batch.get(imported.id, context()).items[0];
  assert.equal(finished.status, "published", JSON.stringify(finished.error));
  assert.equal(finished.authorizedBy, renewalActor);
  assert.equal(finished.authorizedAt, now.toISOString());
  assert.equal(reviewInputs[1].subjectId, originalVariant);
  assert.equal(reviewInputs[1].expectedReviewId, reviewId);
  assert.equal(f.store.snapshot().content.filter(row => row.editionId === finished.editionId).length, 1);
  assert.equal(f.groups.length, 1);
});

test("original review lookup is read-only and a changed work order does not dispatch a different review", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pengmanager-batch-review-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let modelCalls = 0;
  const aiApproval = createAiApproval({ directory, origin, model: { async completeTask() { modelCalls++; } } });
  const original = { kind: "editorial.variant", subjectId: "CNT-example", snapshotHash: "a".repeat(64),
    evidence: { body: "隔离环境稿件的初始证据。" }, criteria: ["核对稿件与证据。"] };
  const reviewId = aiApprovalWorkOrder(original).evidenceHash;
  assert.deepEqual(await aiApproval.inspectReview(reviewId), { status: "pending", reviewId });
  await assert.rejects(aiApproval.review({ ...original, evidence: { body: "隔离环境稿件的已变化证据。" }, expectedReviewId: reviewId }),
    { code: "AI_APPROVAL_INPUT_CHANGED" });
  assert.equal(modelCalls, 0);
  assert.deepEqual(await readdir(directory), []);
});
