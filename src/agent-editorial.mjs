import { CONTENT_ARTIFACT_KINDS, resolveContentIntent } from './domain/content-intent.mjs';
import { ApiError } from './domain/errors.mjs';

const STATUS = 'pengmanager.editorial.status';
const PLAN = 'pengmanager.editorial.plan';
const GET_JOB = 'pengmanager.editorial.job.get';
const CREATE_JOB = 'pengmanager.editorial.job.create';
const DISPATCH_JOB = 'pengmanager.editorial.job.dispatch';
const ROOT = '/api/content-director';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const editableKinds = CONTENT_ARTIFACT_KINDS.filter(kind => !kind.startsWith('video_'));
const jobId = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,120}$' };
const idempotencyKey = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' };
const ifMatch = { type: 'string', pattern: '^"[a-f0-9]{64}"$' };

function capability(id, title, description, operation, properties, required = []) {
  return { id, title, description, operation, risk: 'low', dataMode: 'unverified',
    inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

const planBrief = { type: 'object', properties: {
  intent: { type: 'string', minLength: 1, maxLength: 20_000 },
  explicitKind: { type: 'string', enum: editableKinds },
}, required: ['intent'], additionalProperties: true };
const createBrief = { ...planBrief, required: ['intent', 'explicitKind'] };

export const editorialCapabilities = [
  capability(PLAN, '规划图文内容任务', '按当前工作流确定文章、图文或独立图片路线。只读，不提交模型或创建任务。保留本次用户原话。',
    'read', { brief: planBrief }, ['brief']),
  capability(STATUS, '读取创作总控状态', '查询已由实例所有者配置的本机创作总控状态。', 'read', {}),
  capability(GET_JOB, '读取原图文任务', '按服务器返回的原 job ID 查询当前状态、交付引用及审核信息。',
    'read', { jobId }, ['jobId']),
  capability(CREATE_JOB, '登记图文创作任务', '在已授权的本机工作台创建文章、图文或独立图片任务。保留原请求和幂等键。',
    'execute', { brief: createBrief, idempotencyKey }, ['brief', 'idempotencyKey']),
  capability(DISPATCH_JOB, '启动或续办原图文任务', '核对原任务、当前版本、模型费用及素材授权后启动 Agent 图文任务。使用读取到的完整 ETag 与稳定幂等键。',
    'execute', { jobId, ifMatch, idempotencyKey, confirmProduction: { type: 'boolean', enum: [true] } }, ['jobId', 'ifMatch', 'idempotencyKey', 'confirmProduction']),
];

/** The destination is owner-configured and never supplied by tool arguments. */
export function editorialOrigin(value) {
  if (value === undefined || value === '') return null;
  if (typeof value === 'string' && /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[1-9]\d{0,4})?\/?$/.test(value)) {
    try { return new URL(value).origin; } catch (error) { if (!(error instanceof TypeError)) throw error; }
  }
  throw new ApiError(400, 'EDITORIAL_ORIGIN_INVALID', 'PENGMANAGER_EDITORIAL_ORIGIN 必须是数值回环 HTTP 地址，只能包含协议、主机与端口。');
}

async function responseJson(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE_BYTES) throw new ApiError(502, 'EDITORIAL_RESPONSE_TOO_LARGE', '创作总控响应超过 8 MiB。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(502, 'EDITORIAL_RESPONSE_INVALID', '创作总控未返回有效 JSON。'); }
}

export async function invokeEditorial(id, input, { env, fetchImplementation }) {
  if (id === PLAN) return { ...resolveContentIntent({ ...input.brief, modelDecision: undefined }), originalIntent: input.brief.intent,
    providerCallsPerformed: false, productionVerified: false };
  const origin = editorialOrigin(env.PENGMANAGER_EDITORIAL_ORIGIN);
  if (!origin) throw new ApiError(503, 'EDITORIAL_ORIGIN_REQUIRED', '请由本机实例所有者配置 PENGMANAGER_EDITORIAL_ORIGIN。');
  const routes = {
    [STATUS]: '/status',
    [GET_JOB]: `/jobs/${input.jobId}`,
    [CREATE_JOB]: '/jobs/agent-draft',
    [DISPATCH_JOB]: `/jobs/${input.jobId}/agent-dispatch`,
  };
  const headers = { Accept: 'application/json' };
  const options = { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(30_000) };
  if (id === CREATE_JOB || id === DISPATCH_JOB) {
    options.method = 'POST';
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = input.idempotencyKey;
    if (id === DISPATCH_JOB) headers['If-Match'] = input.ifMatch;
    options.body = JSON.stringify(id === CREATE_JOB ? input.brief : { confirmProduction: input.confirmProduction });
  }
  let response;
  try { response = await fetchImplementation(new URL(ROOT + routes[id], origin), options); }
  catch { throw new ApiError(503, 'EDITORIAL_READBACK_REQUIRED', '未收到本机创作总控确认。使用原任务 ID 或相同的幂等键和原始请求继续核对。'); }
  try {
    const payload = await responseJson(response);
    if (!response.ok) {
      const code = /^[A-Z][A-Z0-9_]{0,80}$/.test(payload?.error?.code ?? '') ? payload.error.code : 'EDITORIAL_REQUEST_DENIED';
      throw new ApiError(response.status, code, `本机创作总控返回 HTTP ${response.status}；请核对原任务或管理员工作台。`);
    }
    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'EDITORIAL_READBACK_REQUIRED', '本机创作总控响应中断。使用原任务 ID 或相同的幂等键和原始请求继续核对。');
  }
}
