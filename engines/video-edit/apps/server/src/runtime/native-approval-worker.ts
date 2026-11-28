import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { getAppPool } from "@workloom/db";
import { gatewayAppendOnClient } from "@workloom/base/workdata";
import { runQuestForThread } from "./thread-runner.js";

const ACTOR = { id: "review-console", type: "system" } as const;
const SCENE_PREFIX = "thr-pm-visual-";
const SHA = /^[a-f0-9]{64}$/u;
const TRUSTED_SCENE = /^thr-pm-visual-[a-f0-9]{64}$/u;
const EXTERNAL_ACTION = /^(?:publish|ads|trade|payment|render|credit|purchase|order|invoice|wallet|accounts?|message|im|skill\.dist|hr|org|fence)\./u;
const ENGINE_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const WORKER_INSTANCE = randomUUID();
const BALANCE_REFUSAL_COOLDOWN_MS = 5 * 60_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const INVALID_VERDICT = "NATIVE_APPROVAL_VERDICT_INVALID";
const REVIEW_PROVIDER = "openai";

type Scope = { tenantId: string; workspaceId: string };
type RecordRow = { approvalId: string; eventId: string; threadId: string; snapshot: Record<string, unknown>;
  event: { decision?: { action?: string; kind?: string; fingerprint?: string; tool?: string; step_id?: string; params?: unknown }; object?: { type?: string; id?: string };
    rule_impact?: Array<{ rule_id?: string; result?: string }> }; title: string; agentId: string; mode: string };
type ApprovalRecord = Scope & RecordRow;
type ProviderReceipt = { provider: string; model: string; responseId: string;
  requestHash: string; responseHash: string; contentHash: string; policyHash: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } };
type Decision = { outcome: "approve" | "reject" | "needs_input"; reason: string; evidenceHash: string;
  checks: Record<string, boolean>; providerReceipt: ProviderReceipt };
type RetryRow = RecordRow & {
  malformedVerdictRetry: { failureId: string; attemptId: string; evidenceHash: string; bindingHash: string } | null;
};
type Preparation = { evidenceHash: string };
type Reviewer = { checkModel(): void; prepare(record: ApprovalRecord): Promise<Preparation>;
  review(prepared: Preparation, options: { signal: AbortSignal }): Promise<Decision> };

function codec(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(codec).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${codec(record[key])}`).join(",")}}`;
}

const digest = (value: unknown) => createHash("sha256").update(codec(value)).digest("hex");
const context = (scope: Scope) => ({ tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" });

/** The AI judges within the existing authorization. It cannot mint account, spend, or external-effect permissions. */
export function nativeApprovalExecutionBlock(row: RecordRow): string | null {
  const { snapshot, event, threadId } = row;
  const action = event.decision?.action ?? "";
  if (!action || typeof snapshot.tool !== "string" || event.decision?.kind !== "review" || snapshot.action !== action ||
      snapshot.tool !== event.decision.tool || !snapshot.step_id || snapshot.step_id !== event.decision.step_id ||
      typeof snapshot.params !== "object" || !snapshot.params || !event.decision.params ||
      digest(snapshot.params) !== digest(event.decision.params) ||
      !snapshot.step_fingerprint || snapshot.step_fingerprint !== event.decision.fingerprint ||
      snapshot.object_type !== event.object?.type || snapshot.object_id !== event.object?.id ||
      !["quest", "agent"].includes(row.mode)) return "NATIVE_APPROVAL_SNAPSHOT_MISMATCH";
  if (snapshot.params_incomplete === true) return "NATIVE_APPROVAL_INPUT_INCOMPLETE";
  if (event.rule_impact?.some(item => ["block", "blocked", "deny", "conflict"].includes(item.result ?? ""))) return "NATIVE_APPROVAL_FENCE_BLOCKED";
  if (snapshot.high_risk !== false || snapshot.irreversible !== false || [action, snapshot.tool].some(value => EXTERNAL_ACTION.test(value))) {
    return "NATIVE_APPROVAL_EXECUTION_AUTHORITY_REQUIRED";
  }
  if (action === "visualwrite.compose" || threadId.startsWith(SCENE_PREFIX)) {
    if (!TRUSTED_SCENE.test(threadId) || action !== "visualwrite.compose" ||
        !event.rule_impact?.some(item => item.rule_id === "G-VIS4" && item.result === "review")) return "NATIVE_APPROVAL_VISUAL_EVIDENCE_REQUIRED";
  }
  return null;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,99}$/.test(code) ? code : "NATIVE_APPROVAL_REVIEW_UNAVAILABLE";
}

function verifiedFailureReceipt(receipt: ProviderReceipt | undefined): receipt is ProviderReceipt {
  return receipt?.provider === REVIEW_PROVIDER && typeof receipt.model === "string" && receipt.model.length > 0 &&
    typeof receipt.responseId === "string" && receipt.responseId.length > 0 && receipt.responseId.length <= 180 &&
    [receipt.requestHash, receipt.responseHash, receipt.contentHash, receipt.policyHash].every(value =>
      typeof value === "string" && SHA.test(value)) &&
    [receipt.usage?.inputTokens, receipt.usage?.outputTokens, receipt.usage?.totalTokens].every(value =>
      Number.isSafeInteger(value) && value > 0);
}

async function scoped<T>(pool: pg.Pool, scope: Scope, action: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.workspace_id', $2, true)", [scope.tenantId, scope.workspaceId]);
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

const APPROVAL_COLUMNS = `a.approval_id AS "approvalId", a.event_id AS "eventId", e.session_id AS "threadId",
  a.snapshot, e.payload AS event, t.title, t.agent_id AS "agentId", t.mode`;
const APPROVAL_TABLES = `FROM approvals a
  JOIN biz_events e ON e.tenant_id=a.tenant_id AND e.workspace_id=a.workspace_id AND e.event_id=a.event_id
  JOIN threads t ON t.tenant_id=a.tenant_id AND t.workspace_id=a.workspace_id AND t.id=e.session_id`;
const PENDING_APPROVAL = `WHERE a.tenant_id=$1 AND a.workspace_id=$2 AND a.channel='inapp' AND a.status='pending'
  AND t.status='pending_review' AND e.payload->'decision'->>'kind'='review'`;
const CANDIDATE = `SELECT ${APPROVAL_COLUMNS} ${APPROVAL_TABLES} ${PENDING_APPROVAL}`;
const SCOPED_APPROVAL_EVENT = `log.tenant_id=a.tenant_id AND log.workspace_id=a.workspace_id
  AND log.session_id=e.session_id AND log.seq>e.seq AND log.payload->'decision'->'after'->>'approvalId'=a.approval_id`;

// A legacy malformed-verdict failure has no persisted receipt or binding hash. Its exact error can only
// follow receipt validation. The linked attempt supplies the original binding and frozen evidence hash.
const REVIEWABLE = `SELECT ${APPROVAL_COLUMNS},
  CASE WHEN latest.action='approval.ai_attempt_unresolved' THEN jsonb_build_object(
    'failureId', latest.event_id, 'attemptId', started.event_id,
    'evidenceHash', started.detail->>'evidenceHash', 'bindingHash', started.detail->>'bindingHash')
  END AS "malformedVerdictRetry"
  ${APPROVAL_TABLES}
  LEFT JOIN LATERAL (
    SELECT log.event_id, log.seq, log.payload, log.payload->'decision'->>'action' AS action,
      log.payload->'decision'->'after' AS detail
    FROM biz_events log WHERE ${SCOPED_APPROVAL_EVENT}
      AND log.payload->'decision'->>'action' IN (
        'approval.ai_attempt_started','approval.ai_attempt_refused','approval.ai_attempt_unresolved',
        'approval.ai_blocked','approval.ai_decision')
    ORDER BY log.seq DESC LIMIT 1
  ) latest ON true
  LEFT JOIN LATERAL (
    SELECT log.event_id, log.payload, log.payload->'decision'->'after' AS detail
    FROM biz_events log WHERE ${SCOPED_APPROVAL_EVENT} AND log.seq<latest.seq
      AND log.payload->'decision'->>'action'='approval.ai_attempt_started'
    ORDER BY log.seq DESC LIMIT 1
  ) started ON latest.action='approval.ai_attempt_unresolved' AND latest.detail->>'reasonCode'='${INVALID_VERDICT}'
  ${PENDING_APPROVAL}
  AND (latest.event_id IS NULL OR (
    CASE WHEN latest.action='approval.ai_attempt_refused'
      THEN CASE WHEN latest.detail->>'retryAt' IS NOT NULL THEN latest.detail->>'retryAt' <= $4
        ELSE latest.detail->>'workerInstance' IS DISTINCT FROM $3 END
    WHEN latest.action='approval.ai_attempt_unresolved' AND latest.detail->>'reasonCode'='${INVALID_VERDICT}'
      THEN e.session_id ~ '${TRUSTED_SCENE.source}' AND e.payload->'decision'->>'action'='visualwrite.compose'
        AND e.payload->'who' @> '{"type":"agent","id":"visual-designer"}'::jsonb
        AND e.payload->'object'->>'type'='design_recipe' AND e.payload->'decision'->>'step_id'='s1'
        AND latest.payload->'who' @> '{"type":"system","id":"${ACTOR.id}"}'::jsonb
        AND started.payload->'who' @> '{"type":"system","id":"${ACTOR.id}"}'::jsonb
        AND latest.payload->'object' @> jsonb_build_object('type','review','id',e.event_id)
        AND started.payload->'object' @> jsonb_build_object('type','review','id',e.event_id)
        AND latest.payload->'links' @> jsonb_build_array(e.event_id, started.event_id)
        AND started.payload->'links' @> jsonb_build_array(e.event_id)
        AND latest.detail->>'authority'='ai' AND started.detail->>'authority'='ai'
        AND latest.detail->>'workerInstance'=started.detail->>'workerInstance'
        AND latest.detail->>'evidenceHash'=started.detail->>'evidenceHash'
        AND started.detail->>'evidenceHash' ~ '${SHA.source}' AND started.detail->>'bindingHash' ~ '${SHA.source}'
        AND (NOT (latest.detail ? 'bindingHash') OR (
          latest.detail->>'bindingHash'=started.detail->>'bindingHash'
          AND latest.detail->'providerReceipt'->>'provider'='${REVIEW_PROVIDER}'))
    ELSE false END
    AND NOT EXISTS (SELECT 1 FROM biz_events log WHERE ${SCOPED_APPROVAL_EVENT}
      AND log.payload->'decision'->>'action'='approval.ai_attempt_started'
      AND log.payload->'decision'->'after' ? 'malformedVerdictRetryOf')
  ))`;

async function ledger(client: pg.PoolClient, scope: Scope, row: RecordRow, action: string, after: Record<string, unknown>, links = [row.eventId]) {
  return gatewayAppendOnClient(client, { ...scope, actor: ACTOR, sessionId: row.threadId }, {
    who: ACTOR, context: context(scope), object: { type: "review", id: row.eventId },
    decision: { action, after: { approvalId: row.approvalId, ...after } }, rule_impact: [], links,
  });
}

function expiry(row: RecordRow): boolean {
  return typeof row.snapshot.expires_at === "string" && Date.parse(row.snapshot.expires_at) > Date.now();
}

export async function advanceNativeApproval(pool: pg.Pool, scope: Scope, reviewer: Reviewer, signal: AbortSignal,
  resume: (row: RecordRow) => Promise<unknown>): Promise<boolean> {
  const values = [scope.tenantId, scope.workspaceId];
  const row = await scoped(pool, scope, async client => (await client.query<RetryRow>(`${REVIEWABLE}
    ORDER BY (e.session_id LIKE 'thr-pm-visual-%') DESC, a.created_at, a.approval_id LIMIT 1`, [...values, WORKER_INSTANCE, new Date().toISOString()])).rows[0]);
  if (!row || signal.aborted) return false;
  const record = { ...row, ...scope };
  const bind = digest({ eventId: row.eventId, snapshot: row.snapshot, event: row.event });
  const retry = row.malformedVerdictRetry;
  const underLock = async (client: pg.PoolClient, reviewable: boolean) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify(["native-ai-approval", ...values, row.approvalId])]);
    const query = reviewable ? `${REVIEWABLE} AND a.approval_id=$5 FOR UPDATE OF a, t`
      : `${CANDIDATE} AND a.approval_id=$3 FOR UPDATE OF a, t`;
    const argumentsForQuery = reviewable ? [...values, WORKER_INSTANCE, new Date().toISOString(), row.approvalId] : [...values, row.approvalId];
    const found = (await client.query<RecordRow & Partial<RetryRow>>(query, argumentsForQuery)).rows[0];
    if (reviewable && found?.malformedVerdictRetry?.failureId !== retry?.failureId) return null;
    return found && digest({ eventId: found.eventId, snapshot: found.snapshot, event: found.event }) === bind ? found : null;
  };
  let blocked = expiry(row) ? nativeApprovalExecutionBlock(row) : "NATIVE_APPROVAL_EXPIRED";
  let prepared: Preparation | null = null;
  if (!blocked) {
    try { prepared = await reviewer.prepare(record); }
    catch (error) { blocked = errorCode(error); }
  }
  if (!blocked && retry && (retry.bindingHash !== bind || retry.evidenceHash !== prepared?.evidenceHash)) {
    blocked = "NATIVE_APPROVAL_RETRY_BASIS_CHANGED";
  }
  if (blocked || !prepared) {
    await scoped(pool, scope, async client => {
      if (await underLock(client, true)) await ledger(client, scope, row, "approval.ai_blocked", { authority: "policy", reasonCode: blocked, bindingHash: bind });
    });
    return true;
  }
  reviewer.checkModel(); // Missing credentials has no dispatch and never consumes the original approval.
  const attemptedEvidence = prepared.evidenceHash;
  const attempt = await scoped(pool, scope, async client => {
    const fresh = await underLock(client, true);
    if (!fresh || !expiry(fresh) || signal.aborted) return null;
    return ledger(client, scope, row, "approval.ai_attempt_started", { authority: "ai", evidenceHash: attemptedEvidence,
      bindingHash: bind, workerInstance: WORKER_INSTANCE, ...(retry ? { malformedVerdictRetryOf: retry.failureId } : {}) },
    retry ? [row.eventId, retry.attemptId, retry.failureId] : [row.eventId]);
  });
  if (!attempt) return true;
  let decision: Decision;
  try {
    decision = await reviewer.review(prepared, { signal });
    if (decision.evidenceHash !== attemptedEvidence || !SHA.test(attemptedEvidence) ||
        (await reviewer.prepare(record)).evidenceHash !== attemptedEvidence) {
      throw Object.assign(new Error("Native approval evidence changed during review"), { code: "NATIVE_APPROVAL_EVIDENCE_CHANGED" });
    }
  } catch (error) {
    const failure = error as { httpStatus?: number; unknown?: boolean; wireSha256?: string; providerReceipt?: ProviderReceipt };
    const reasonCode = errorCode(error);
    const refused = failure?.unknown === false && [401, 402, 403, 429].includes(failure?.httpStatus ?? 0);
    const cooldown = failure?.httpStatus === 402 ? BALANCE_REFUSAL_COOLDOWN_MS : failure?.httpStatus === 429 ? RATE_LIMIT_COOLDOWN_MS : null;
    const retryAt = !retry && refused && cooldown ? new Date(Date.now() + cooldown).toISOString() : null;
    await scoped(pool, scope, client => ledger(client, scope, row, refused ? "approval.ai_attempt_refused" : "approval.ai_attempt_unresolved",
      { authority: "ai", evidenceHash: attemptedEvidence, bindingHash: bind, reasonCode, workerInstance: WORKER_INSTANCE,
        ...(refused ? { httpStatus: failure.httpStatus } : {}), ...(retryAt ? { retryAt } : {}),
        ...(reasonCode === INVALID_VERDICT && failure?.unknown !== true && verifiedFailureReceipt(failure?.providerReceipt)
          ? { providerReceipt: failure.providerReceipt } : {}),
        ...(SHA.test(failure?.wireSha256 ?? "") ? { wireSha256: failure.wireSha256 } : {}) }, [row.eventId, attempt.eventId]));
    return true;
  }
  const approved = await scoped(pool, scope, async client => {
    const fresh = await underLock(client, false);
    if (!fresh || !expiry(fresh) || signal.aborted) {
      await ledger(client, scope, row, "approval.ai_blocked", { authority: "ai", evidenceHash: attemptedEvidence,
        reasonCode: "NATIVE_APPROVAL_STALE", providerReceipt: decision.providerReceipt }, [row.eventId, attempt.eventId]);
      return false;
    }
    const decisionHash = digest(decision);
    if (decision.outcome !== "needs_input") {
      const status = decision.outcome === "approve" ? "approved" : "rejected";
      await client.query(`UPDATE approvals SET status=$4, decided_by=$5, decided_at=now(), gesture=$6
        WHERE approval_id=$3 AND tenant_id=$1 AND workspace_id=$2 AND status='pending'`,
      [...values, row.approvalId, status, ACTOR.id, JSON.stringify({ type: decision.outcome, weight: 0, authority: "ai", decisionHash })]);
      if (decision.outcome === "reject") await client.query(`UPDATE threads SET status='cancelled', updated_at=now()
        WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND status='pending_review'`, [...values, row.threadId]);
    }
    await ledger(client, scope, row, "approval.ai_decision", { authority: "ai", decisionHash, ...decision }, [row.eventId, attempt.eventId]);
    return decision.outcome === "approve";
  });
  if (approved) await resume(row);
  return true;
}

export function managedNativeApprovalWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env.PENGMANAGER_ENGINE_ROOT || !env.PENGMANAGER_VIDEO_DATA_DIR || env.WORKLOOM_DESKTOP_WORKSPACE !== "pengmanager-video") return false;
  return realpathSync(env.PENGMANAGER_ENGINE_ROOT) === realpathSync(ENGINE_ROOT);
}

async function resumeAlreadyApproved(pool: pg.Pool, scope: Scope, resume: (row: RecordRow) => Promise<unknown>): Promise<boolean> {
  const row = await scoped(pool, scope, async client => (await client.query<RecordRow>(`SELECT a.approval_id AS "approvalId", a.event_id AS "eventId",
      e.session_id AS "threadId", a.snapshot, e.payload AS event, t.title, t.agent_id AS "agentId", t.mode
    FROM approvals a JOIN biz_events e ON e.tenant_id=a.tenant_id AND e.workspace_id=a.workspace_id AND e.event_id=a.event_id
    JOIN threads t ON t.tenant_id=a.tenant_id AND t.workspace_id=a.workspace_id AND t.id=e.session_id
    WHERE a.tenant_id=$1 AND a.workspace_id=$2 AND a.channel='inapp' AND a.status='approved' AND a.consumed_at IS NULL
      AND a.decided_by=$3 AND a.gesture->>'authority'='ai' AND t.status='pending_review'
      AND a.snapshot->>'expires_at' > $4
      AND EXISTS (SELECT 1 FROM biz_events d
        WHERE d.tenant_id=a.tenant_id AND d.workspace_id=a.workspace_id AND d.session_id=e.session_id AND d.seq>e.seq
          AND d.payload->'who'->>'type'='system' AND d.payload->'who'->>'id'=$3
          AND d.payload->'object'->>'type'='review' AND d.payload->'object'->>'id'=e.event_id
          AND d.payload->'decision'->>'action'='approval.ai_decision'
          AND d.payload->'decision'->'after'->>'approvalId'=a.approval_id
          AND d.payload->'decision'->'after'->>'authority'='ai' AND d.payload->'decision'->'after'->>'outcome'='approve'
          AND d.payload->'decision'->'after'->>'decisionHash'=a.gesture->>'decisionHash')
    ORDER BY a.decided_at`, [scope.tenantId, scope.workspaceId, ACTOR.id, new Date().toISOString()])).rows.find(candidate =>
      expiry(candidate) && nativeApprovalExecutionBlock(candidate) === null));
  if (!row) return false;
  await resume(row);
  return true;
}

export async function startNativeApprovalWorker(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!managedNativeApprovalWorker(env)) return;
  const moduleUrl = new URL("../../../../../../src/video-runtime/native-approval-review.mjs", import.meta.url);
  const { createNativeApprovalReviewer } = await import(moduleUrl.href) as { createNativeApprovalReviewer(input: unknown): Reviewer };
  const scope = { tenantId: "tenant-pengmanager-video", workspaceId: "ws-pengmanager-video" };
  const reviewer = createNativeApprovalReviewer({ dataRoot: env.PENGMANAGER_VIDEO_DATA_DIR, env });
  let lastError: string | null = null;
  const resume = (row: RecordRow) => runQuestForThread(scope, { threadId: row.threadId, goal: row.title, presetRef: row.agentId,
    ...(row.mode === "agent" ? { mode: "agent" as const } : {}) });
  const tick = async () => {
    try {
      const pool = getAppPool();
      if (!(await resumeAlreadyApproved(pool, scope, resume))) {
        await advanceNativeApproval(pool, scope, reviewer, AbortSignal.timeout(600_000), resume);
      }
      lastError = null;
    } catch (error) {
      const code = errorCode(error);
      if (lastError !== code) console.warn(`[approval] Native AI review unavailable: ${code}`);
      lastError = code;
    }
    setTimeout(() => { void tick(); }, 4000).unref();
  };
  void tick();
}
