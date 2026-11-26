import { hashObject, hashText } from "../domain/hash.mjs";
import { parseStrictJson } from "../domain/strict-json.mjs";
import { CODEX_MODEL_IDS } from "./codex-pricing.mjs";
import { modelError } from "./errors.mjs";
import { MODEL_POLICY, policyReceipt, resolveScenePolicy } from "./policy.mjs";

export const CODEX_DEFAULT_MODEL = CODEX_MODEL_IDS[0];
export const CODEX_REGISTRY_VERSION = "2026-11-26.1";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = 48 * 1024 * 1024;

export function codexTextRegistration({ env = process.env, model } = {}) {
  const selected = String(env.PENGMANAGER_CODEX_MODEL || CODEX_DEFAULT_MODEL).trim();
  if (!CODEX_MODEL_IDS.includes(selected) || (model !== undefined && model !== selected)) {
    throw modelError("MODEL_ID_NOT_ALLOWED", "模型必须与鹏经理 Codex 版登记的 GPT 模型一致。");
  }
  return Object.freeze({
    key: "text.primary",
    registryVersion: CODEX_REGISTRY_VERSION,
    provider: "openai",
    protocol: "openai-responses",
    officialModelId: selected,
    baseUrl: OPENAI_BASE_URL,
    contextTokens: 1_050_000,
    maxInputTokens: 922_000,
    maxOutputTokens: 128_000,
  });
}

function asResponsesInput(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    throw modelError("MODEL_MESSAGES_REQUIRED", "模型任务至少需要一条完整消息。");
  }
  return messages.map(({ role, content }) => {
    if (!["system", "developer", "user", "assistant"].includes(role)) {
      throw modelError("MODEL_INPUT_ROLE_UNSUPPORTED", "模型输入包含当前流程不支持的消息角色。");
    }
    if (typeof content === "string") return { role, content };
    if (!Array.isArray(content) || !content.length || role === "assistant") {
      throw modelError("MODEL_INPUT_CONTENT_UNSUPPORTED", "模型输入包含当前流程不支持的内容。");
    }
    return { role, content: content.map(part => {
      if (["text", "input_text"].includes(part?.type) && typeof part.text === "string") {
        return { type: "input_text", text: part.text };
      }
      if (["image_url", "input_image"].includes(part?.type) && role === "user") {
        const imageUrl = part.image_url?.url ?? part.image_url;
        const detail = part.image_url?.detail ?? part.detail ?? "auto";
        if (typeof imageUrl === "string" && /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(imageUrl)
          && ["low", "high", "auto"].includes(detail)) {
          return { type: "input_image", image_url: imageUrl, detail };
        }
      }
      throw modelError("MODEL_INPUT_CONTENT_UNSUPPORTED", "模型输入仅接受文本和经本地授权读入的图片。");
    }) };
  });
}

async function readEnvelope(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing response body");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)));
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Response exceeds byte limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
}

async function postJson(fetchImpl, route, wire, apiKey, { signal, timeoutMs, generation }) {
  if (signal?.aborted) throw modelError("MODEL_CANCELLED", "模型请求已在发送前取消。");
  const deadline = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(route, {
      method: "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: wire,
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
  } catch (cause) {
    const code = signal?.aborted ? "MODEL_CANCELLED" : deadline.aborted ? "MODEL_TIMEOUT" : "MODEL_NETWORK_UNKNOWN";
    throw modelError(code, generation ? "模型发送结果和用量未知。" : "生成前的模型输入计量未完成。", {
      unknown: generation, cause,
    });
  }
  if (!response.ok) {
    const error = modelError(`MODEL_HTTP_${response.status}`, `OpenAI 请求返回 HTTP ${response.status}。`, {
      httpStatus: response.status,
      unknown: generation && (response.status >= 500 || response.status === 408),
    });
    if (response.body) await response.body.cancel().catch(() => { error.bodyReleaseFailed = true; });
    throw error;
  }
  try {
    const envelope = await readEnvelope(response);
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("Invalid envelope");
    return envelope;
  } catch (cause) {
    throw modelError("MODEL_RESPONSE_UNKNOWN", "OpenAI 响应无法完整读取。", { unknown: generation, cause });
  }
}

function safeTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function parseUsage(value, budget, registration, webSearch) {
  const inputTokens = value?.input_tokens;
  const outputTokens = value?.output_tokens;
  const totalTokens = value?.total_tokens;
  const cached = value?.input_tokens_details?.cached_tokens;
  const reasoning = value?.output_tokens_details?.reasoning_tokens;
  const cacheWrites = value?.input_tokens_details?.cache_write_tokens;
  if (![inputTokens, outputTokens, totalTokens].every(safeTokenCount)
    || totalTokens !== inputTokens + outputTokens || totalTokens > registration.contextTokens
    || (!webSearch && inputTokens > budget.inputTokens) || outputTokens > budget.outputCeiling
    || (cacheWrites !== undefined && cacheWrites !== 0)
    || (cached !== undefined && (!safeTokenCount(cached) || cached > inputTokens))
    || (reasoning !== undefined && (!safeTokenCount(reasoning) || reasoning > outputTokens))) {
    throw modelError("MODEL_USAGE_INVALID", "OpenAI 返回的模型用量缺失或超出已核定预算。", { unknown: true });
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens: reasoning ?? null,
    promptCacheHitTokens: cached ?? null,
    promptCacheMissTokens: cached === undefined ? null : inputTokens - cached,
  };
}

function extractWebEvidence(output) {
  const sources = new Map();
  const citations = new Map();
  const record = (target, entry) => {
    if (!URL.canParse(entry?.url)) return;
    const url = new URL(entry.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
    if (!target.has(url.href) || entry.title) {
      target.set(url.href, { url: url.href, title: String(entry.title || url.hostname), domain: url.hostname });
    }
  };
  for (const item of output) {
    if (item.type === "web_search_call" && item.status === "completed") {
      for (const entry of item.action?.sources ?? []) record(sources, entry);
    }
    if (item.type === "message" && item.role === "assistant" && item.status === "completed") {
      for (const annotation of (item.content ?? []).flatMap(part => part.annotations ?? [])) {
        if (annotation.type === "url_citation") record(citations, annotation);
      }
    }
  }
  return {
    sources: [...new Map([...sources, ...citations]).values()],
    citations: [...citations.values()],
  };
}

export async function prepareCodexText({
  env = process.env, model, messages, responseFormat = "text", thinking, signal, timeoutMs = 600_000,
  maxOutputTokens, maxRequestBytes = MAX_REQUEST_BYTES, fetchImpl = globalThis.fetch, webSearch = false,
} = {}) {
  const registration = codexTextRegistration({ env, model });
  const apiKey = String(env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) throw modelError("MODEL_CREDENTIAL_MISSING", "鹏经理 Codex 版需要进程内的 OPENAI_API_KEY。");
  if (typeof fetchImpl !== "function") throw modelError("MODEL_TRANSPORT_UNAVAILABLE", "模型传输不可用。");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 2_147_483_647) {
    throw modelError("MODEL_TIMEOUT_INVALID", "模型超时必须是受支持的毫秒整数。");
  }
  if (!["text", "json_object"].includes(responseFormat)) {
    throw modelError("MODEL_RESPONSE_FORMAT_INVALID", "模型响应格式未登记。");
  }
  if (maxOutputTokens !== undefined && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 16)) {
    throw modelError("MODEL_OUTPUT_BUDGET_INVALID", "模型输出上限必须是至少 16 的整数。");
  }
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > MAX_REQUEST_BYTES) {
    throw modelError("MODEL_REQUEST_LIMIT_INVALID", "模型请求字节上限无效。");
  }
  const ensureRequestSize = wire => {
    const requestBytes = Buffer.byteLength(wire);
    if (requestBytes > maxRequestBytes) {
      throw modelError("MODEL_REQUEST_BODY_TOO_LARGE", "完整请求超过字节上限，未发送该请求。");
    }
    return requestBytes;
  };
  const effort = thinking?.type === "disabled" ? "low" : thinking?.effort === "max" ? "xhigh" : thinking?.effort ?? "high";
  if (!["low", "medium", "high", "xhigh"].includes(effort)) {
    throw modelError("MODEL_THINKING_POLICY_INVALID", "Codex 模型推理强度未登记。");
  }
  const endpoint = `${registration.baseUrl}/responses`;
  const input = asResponsesInput(messages);
  if (responseFormat === "json_object") {
    // Responses JSON mode requires explicit JSON instructions in the request.
    input.unshift({ role: "developer", content: "Return only one valid JSON object, as requested by the task." });
  }
  const sharedBody = {
    model: registration.officialModelId,
    input,
    reasoning: { effort },
    text: { format: { type: responseFormat } },
    truncation: "disabled",
    ...(webSearch ? { tools: [{ type: "web_search" }] } : {}),
  };
  const countWire = JSON.stringify(sharedBody);
  ensureRequestSize(countWire);
  const count = await postJson(fetchImpl, `${endpoint}/input_tokens`, countWire, apiKey, { signal, timeoutMs, generation: false });
  if (count.object !== "response.input_tokens" || !safeTokenCount(count.input_tokens)) {
    throw modelError("MODEL_INPUT_WINDOW_UNVERIFIED", "OpenAI 未返回有效的完整输入计量，生成请求未发送。");
  }
  const inputTokens = count.input_tokens;
  const legalRemaining = registration.contextTokens - inputTokens;
  const legalCeiling = Math.min(registration.maxOutputTokens, legalRemaining);
  const outputCeiling = Math.min(legalCeiling, maxOutputTokens ?? legalCeiling);
  if (inputTokens > registration.maxInputTokens || outputCeiling < 16) {
    throw modelError("MODEL_CONTEXT_EXCEEDED", "完整输入超过模型窗口或无法为输出预留空间，生成请求未发送。");
  }
  const budget = Object.freeze({
    inputTokens,
    inputTokenEstimate: inputTokens,
    inputTokenBasis: "openai-responses-input-tokens",
    inputCountWireSha256: hashText(countWire),
    legalRemaining,
    outputCeiling,
    outputConstrainedByProduct: outputCeiling < legalCeiling,
  });
  const wire = JSON.stringify({
    ...sharedBody,
    store: false,
    service_tier: "default",
    prompt_cache_options: { mode: "explicit" },
    max_output_tokens: outputCeiling,
    ...(webSearch ? { max_tool_calls: 4, include: ["web_search_call.action.sources"] } : {}),
  });
  const requestBytes = ensureRequestSize(wire);
  const wireSha256 = hashText(wire);
  const requestHash = hashObject({ endpoint, wireSha256, budget });
  let executed = false;
  return {
    model: registration.officialModelId,
    provider: registration.provider,
    registryVersion: registration.registryVersion,
    requestBytes,
    requestHash,
    wireSha256,
    budget,
    upperBound: { inputTokens, outputTokens: outputCeiling, renderSeconds: 0, tempBytes: 1_000_000, nativeProcesses: 0 },
    async execute({ signal: executionSignal = signal } = {}) {
      if (executed) throw modelError("MODEL_DISPATCH_REPLAY_BLOCKED", "同一已准备模型请求不得重复发送。");
      executed = true;
      try {
        const envelope = await postJson(fetchImpl, endpoint, wire, apiKey, { signal: executionSignal, timeoutMs, generation: true });
        const providerRequestId = typeof envelope.id === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(envelope.id) ? envelope.id : null;
        if (!providerRequestId || envelope.model !== registration.officialModelId) {
          throw modelError(envelope.model !== registration.officialModelId ? "MODEL_IDENTITY_CHANGED" : "MODEL_IDENTITY_MISSING",
            "OpenAI 响应身份无法与请求核对。", { unknown: true, providerRequestId });
        }
        const responseHash = hashObject(envelope);
        if (envelope.service_tier && envelope.service_tier !== "default") {
          throw modelError("MODEL_SERVICE_TIER_CHANGED", "OpenAI 返回了原预算未授权的服务等级。", {
            unknown: true, providerRequestId,
          });
        }
        let usage;
        try { usage = parseUsage(envelope.usage, budget, registration, webSearch); }
        catch (error) {
          error.providerRequestId = providerRequestId;
          error.responseHash = responseHash;
          throw error;
        }
        const usageReceipt = { kind: "provider_response_usage", sha256: responseHash, providerRequestId,
          model: envelope.model, pricingSnapshotHash: null, tokenBoundProofHash: null, actualCostVerified: false };
        let content, value, foundWebSearch, webEvidence;
        try {
          if (envelope.status !== "completed" || envelope.incomplete_details || envelope.error) {
            throw modelError(envelope.incomplete_details?.reason === "max_output_tokens" ? "MODEL_OUTPUT_TRUNCATED" : "MODEL_OUTPUT_INCOMPLETE",
              "OpenAI 未完整结束生成。");
          }
          const output = Array.isArray(envelope.output) ? envelope.output : [];
          const finalParts = output.filter(item => item.type === "message" && item.role === "assistant"
            && item.status === "completed").flatMap(item => item.content ?? []);
          if (finalParts.some(part => part.type === "refusal")) throw modelError("MODEL_OUTPUT_REFUSED", "OpenAI 拒绝生成。");
          content = finalParts.filter(part => part.type === "output_text" && typeof part.text === "string")
            .map(part => part.text).join("").trim();
          if (!content) throw modelError("MODEL_CONTENT_EMPTY", "OpenAI 最终文本为空。");
          value = content;
          if (responseFormat === "json_object") {
            try {
              value = parseStrictJson(content, { maxBytes: MAX_RESPONSE_BYTES, maxString: 4_000_000 });
              if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
            } catch (cause) { throw modelError("MODEL_OUTPUT_SCHEMA_INVALID", "模型输出未通过 JSON 对象校验。", { cause }); }
          }
          foundWebSearch = webSearch && output.some(item => item.type === "web_search_call" && item.status === "completed");
          webEvidence = foundWebSearch ? extractWebEvidence(output) : { sources: [], citations: [] };
        } catch (error) {
          error.metering = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costMicros: null, currency: null };
          error.usageReceipt = usageReceipt;
          error.providerRequestId = providerRequestId;
          error.receipt = { usage, responseHash, providerRequestId };
          throw error;
        }
        return {
          content, value, model: envelope.model, providerRequestId, responseHash, usageReceipt,
          effort, ...webEvidence, foundWebSearch,
          usage: {
            prompt_tokens: usage.inputTokens,
            completion_tokens: usage.outputTokens,
            total_tokens: usage.totalTokens,
            prompt_cache_hit_tokens: usage.promptCacheHitTokens,
            prompt_cache_miss_tokens: usage.promptCacheMissTokens,
            completion_tokens_details: { reasoning_tokens: usage.reasoningTokens },
          },
          meteredUsage: usage,
        };
      } catch (error) {
        error.wireSha256 = wireSha256;
        error.attempts = [{ attempt: 1, code: error.code ?? "MODEL_RESPONSE_UNKNOWN", unknown: error.unknown === true,
          providerRequestId: error.providerRequestId ?? null, retryable: false }];
        throw error;
      }
    },
  };
}

export async function runCodexText(options) {
  return (await prepareCodexText(options)).execute();
}

export class CodexModelDispatcher {
  constructor({ env = process.env, fetchImpl, timeoutMs } = {}) {
    this.options = { env, fetchImpl, timeoutMs };
  }

  health() {
    const registration = codexTextRegistration(this.options);
    return {
      configured: Boolean(String(this.options.env.OPENAI_API_KEY ?? "").trim()),
      model: registration.officialModelId,
      modelKey: registration.key,
      mode: registration.protocol,
      provider: registration.provider,
      contextTokens: registration.contextTokens,
      maxOutputTokens: registration.maxOutputTokens,
      policyVersion: MODEL_POLICY.policyVersion,
      fallback: MODEL_POLICY.defaults.fallback,
    };
  }

  async prepareTask({ scene, messages, tools = [], signal, maxOutputTokens, maxRequestBytes, webSearch = false }) {
    if (!Array.isArray(tools) || tools.length) {
      throw modelError("MODEL_TOOLS_UNSUPPORTED", "该模型场景仅接受已登记的联网检索工具。");
    }
    const policy = resolveScenePolicy(scene);
    const prepared = await prepareCodexText({
      ...this.options, messages, signal, maxOutputTokens, maxRequestBytes, webSearch,
      responseFormat: policy.responseFormat, thinking: policy.thinking,
    });
    const effectivePolicy = policyReceipt(policy);
    // GPT-6.2 requires reasoning. Deterministic scenes use its lowest
    // reasoning effort and the receipt records the actual wire setting.
    effectivePolicy.requestedThinking = effectivePolicy.thinking;
    effectivePolicy.thinking = { type: "enabled", effort: policy.thinking.type === "disabled"
      ? "low" : policy.thinking.effort === "max" ? "xhigh" : policy.thinking.effort };
    const policyHash = hashObject(effectivePolicy);
    const requestHash = hashObject({ scene, providerRequestHash: prepared.requestHash, policyHash });
    return {
      ...prepared,
      scene,
      policy: effectivePolicy,
      requestHash,
      execute: async (options) => {
        const result = await prepared.execute(options);
        const usage = result.meteredUsage;
        const receipt = {
          schemaVersion: "workloom.model-receipt/v1",
          policy: effectivePolicy,
          policyHash,
          registry: { key: "text.primary", version: CODEX_REGISTRY_VERSION, provider: "openai",
            requestedModel: prepared.model, returnedModel: result.model },
          modelKey: "text.primary",
          requestedModel: prepared.model,
          returnedModel: result.model,
          responseId: result.providerRequestId,
          requestHash,
          wireSha256: prepared.wireSha256,
          responseHash: result.responseHash,
          contentHash: hashText(result.content),
          finishReason: "stop",
          budget: prepared.budget,
          usage,
          attempt: 1,
          attempts: [],
          receivedAt: new Date().toISOString(),
        };
        return {
          text: result.content, value: result.value, model: result.model, requestedModel: prepared.model,
          resolvedModel: result.model, responseId: result.providerRequestId, responseHash: result.responseHash,
          finishReason: "stop", mode: "enabled", effort: result.effort, outputCeiling: prepared.budget.outputCeiling,
          usage, requestHash, wireSha256: prepared.wireSha256, policyHash, registryVersion: CODEX_REGISTRY_VERSION,
          attempts: [], receipt, sources: result.sources, citations: result.citations, foundWebSearch: result.foundWebSearch,
        };
      },
    };
  }

  async completeTask(options) {
    return (await this.prepareTask(options)).execute();
  }
}
