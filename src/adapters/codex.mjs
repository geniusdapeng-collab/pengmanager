import { hashText } from "../domain/hash.mjs";
import { CodexModelDispatcher, codexTextRegistration } from "../model-routing/codex.mjs";
import { modelError } from "../model-routing/errors.mjs";
import { generateModelContent } from "./generated-content.mjs";

export class CodexAdapter {
  constructor({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs, dispatcher } = {}) {
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.dispatcher = dispatcher ?? new CodexModelDispatcher({ env, fetchImpl, timeoutMs });
  }

  async health() {
    let health;
    try {
      health = this.dispatcher.health();
      if (!health.configured) return { ...health, ok: false, error: "MODEL_CREDENTIAL_MISSING" };
      const { baseUrl, officialModelId } = codexTextRegistration({ env: this.env });
      const response = await this.fetchImpl(`${baseUrl}/models/${officialModelId}`, {
        headers: { Authorization: `Bearer ${String(this.env.OPENAI_API_KEY).trim()}` },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (response.body) await response.body.cancel();
      return { ...health, ok: response.ok, ...(response.ok ? {} : { error: `MODEL_HTTP_${response.status}` }) };
    } catch (error) {
      return { configured: Boolean(this.env.OPENAI_API_KEY), ...health, ok: false, error: error.code ?? "MODEL_HEALTH_UNAVAILABLE" };
    }
  }

  completeTask(options) {
    return this.dispatcher.completeTask(options);
  }

  async chat(prompt, {
    scene = "geo.answer.synthesize",
    systemPrompt = "你是独立的 AI 产品与 GEO 研究助手。只能依据给定事实和搜索结果回答；证据不足时明确说明。",
    signal, webSearch = false,
  } = {}) {
    const result = await this.completeTask({
      scene, signal, webSearch,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }],
    });
    return { ...result, answer: result.text, completionId: result.responseId };
  }

  respond(prompt, options) {
    return this.chat(prompt, options);
  }

  async search(query, { count = 5 } = {}) {
    const result = await this.chat(query, {
      webSearch: true,
      systemPrompt: "使用联网检索核对问题。请引用实际访问的来源。禁止编造链接或把推测当作证据。",
    });
    if (!result.foundWebSearch || !result.sources.length) {
      throw modelError("MODEL_SEARCH_EVIDENCE_MISSING", "联网检索未返回可核对的来源。");
    }
    return {
      results: result.sources.slice(0, Math.min(Math.max(Number(count) || 5, 1), 20))
        .map(source => ({ ...source, snippet: "" })),
      responseHash: result.responseHash,
    };
  }

  async answerQuery(query) {
    const result = await this.chat(query.text, {
      webSearch: true,
      systemPrompt: "作为独立研究助手，请用真实联网来源回答并引用。无法核对时明确说明。",
    });
    if (!result.foundWebSearch || !result.citations.length) {
      throw modelError("MODEL_SEARCH_EVIDENCE_MISSING", "联网检索未返回可核对的来源。");
    }
    const citations = result.citations;
    return {
      answer: result.answer,
      citations,
      model: result.model,
      evidence: {
        schemaVersion: "pengmanager.openai-answer/v1",
        queryId: query.id,
        query: query.text,
        queryLocale: query.locale,
        surface: "OpenAI Responses web search",
        transport: "openai-responses",
        model: result.model,
        completionId: result.completionId,
        completionResponseHash: result.responseHash,
        completionRequestHash: result.requestHash,
        policy: result.receipt.policy,
        usage: result.usage,
        answer: result.answer,
        answerHash: hashText(result.answer),
        citations,
        capturedAt: new Date().toISOString(),
      },
    };
  }

  async generateContent(request) {
    const result = await generateModelContent(this.dispatcher, request);
    return { ...result, provider: "openai" };
  }
}
