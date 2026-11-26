import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { maskDeep } from "../workdata/pii.js";
import { ModelProviderError, type ChatMessage, type ChatOptions, type ChatResult, type ModelProvider } from "./providers.js";
import { resolveTextScenePolicy, type TextScenePolicy, type ThinkingEffort } from "./deepseek-policy.js";
import { TEXT_PRIMARY_POLICY_VERSION } from "./token-budget.js";

type Env = Record<string, string | undefined>;

interface Registration {
  officialModelId: string;
  provider: "openai";
  protocol: "openai-responses";
  baseUrl: string;
  contextTokens: number;
  maxOutputTokens: number;
  registryVersion: string;
}

export interface CodexVideoPlan {
  model: string;
  requestHash: string;
  requestBytes: number;
  upperBound: { inputTokens: number };
  budget: { inputTokens: number; outputCeiling: number };
  execute(options?: { signal?: AbortSignal }): Promise<{
    content: string;
    model: string;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    };
    providerRequestId: string;
    responseHash: string;
    effort: "low" | "medium" | "high" | "xhigh";
  }>;
}

interface CodexTransport {
  codexTextRegistration(options: { env: Env }): Registration;
  prepareCodexText(options: {
    env: Env; model: string; messages: ChatMessage[];
    responseFormat: "json_object" | "text";
    thinking: TextScenePolicy["thinking"];
    signal?: AbortSignal; timeoutMs?: number;
    maxOutputTokens?: number; maxRequestBytes?: number; fetchImpl?: typeof fetch;
  }): Promise<CodexVideoPlan>;
}

const require = createRequire(import.meta.url);
function transport(): CodexTransport {
  // Load only in the embedded Codex edition. The upstream engine's standalone
  // and offline configurations do not depend on PengManager's host modules.
  return require(fileURLToPath(new URL("../../../../../src/model-routing/codex.mjs", import.meta.url)));
}

export function codexVideoLongContextBilling(model: string, inputTokens: number): boolean {
  const pricing = require(fileURLToPath(new URL("../../../../../src/model-routing/codex-pricing.mjs", import.meta.url))) as {
    codexLongContextBilling: (model: string, inputTokens: number) => boolean;
  };
  return pricing.codexLongContextBilling(model, inputTokens);
}

export const CODEX_INPUT_TOKEN_BASIS = "openai-responses-input-tokens/v1";
export const CODEX_REQUEST_BODY_LIMIT_BYTES = 48 * 1024 * 1024;

export function usesCodexText(env: Env = process.env): boolean {
  return env.LLM_PROVIDER === "codex";
}

export function codexVideoRegistration(env: Env = process.env): Registration {
  return transport().codexTextRegistration({ env });
}

export function requireCodexModel(model: string | undefined, env: Env = process.env): string {
  const registered = codexVideoRegistration(env).officialModelId;
  if (model?.trim() && model.trim() !== registered) throw new Error("TEXT_PRIMARY_MODEL_MISMATCH");
  return registered;
}

type ChatGuard = (plan: CodexVideoPlan, send: () => Promise<ChatResult>) => Promise<ChatResult>;

export class CodexTextProvider implements ModelProvider {
  readonly modelId: string;
  private readonly env: Env;

  constructor(private readonly config: {
    env?: Env; model?: string; fetchImpl?: typeof fetch; maxRequestBytes?: number; guard?: ChatGuard; beforePrepare?: () => void;
  } = {}) {
    this.env = config.env ?? process.env;
    this.modelId = requireCodexModel(config.model, this.env);
  }

  withGuard(guard: ChatGuard, beforePrepare: () => void): CodexTextProvider {
    return new CodexTextProvider({ ...this.config, guard, beforePrepare });
  }

  async healthy(): Promise<boolean> {
    return Boolean(this.env.OPENAI_API_KEY?.trim());
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const scene = opts.scene ?? "generic";
    const policy = resolveTextScenePolicy(scene);
    const responseFormat = opts.responseFormat?.type ?? policy.responseFormat;
    if (responseFormat !== "text" && responseFormat !== "json_object") {
      throw new ModelProviderError("模型输出格式未登记", "protocol");
    }
    const mode = opts.thinking?.type ?? policy.thinking.type;
    if (mode !== "enabled" && mode !== "disabled") throw new ModelProviderError("模型思考方式未登记", "protocol");
    const effort: ThinkingEffort | undefined = mode === "enabled"
      ? opts.reasoningEffort ?? policy.thinking.effort ?? "high" : undefined;
    const input = messages.map(message => ({
      ...message,
      content: typeof message.content === "string" ? maskDeep(message.content).value
        : message.content.map(part => {
          if (part.type === "text") return { ...part, text: maskDeep(part.text).value };
          if (part.type === "image_url" && part.image_url.detail === "original") {
            // The exact authorized bytes remain attached. OpenAI uses "high"
            // to request its highest supported image detail on this endpoint.
            return { ...part, image_url: { ...part.image_url, detail: "high" as const } };
          }
          return part;
        }),
    }));
    const registration = codexVideoRegistration(this.env);
    this.config.beforePrepare?.();
    const plan = await transport().prepareCodexText({
      env: this.env, model: this.modelId, messages: input, responseFormat,
      thinking: effort ? { type: mode, effort } : { type: mode },
      signal: opts.signal, timeoutMs: opts.timeoutMs, maxOutputTokens: opts.productOutputCap,
      maxRequestBytes: this.config.maxRequestBytes ?? CODEX_REQUEST_BODY_LIMIT_BYTES,
      fetchImpl: this.config.fetchImpl,
    });
    if (!Number.isSafeInteger(plan.requestBytes) || plan.requestBytes < 1
      || plan.requestBytes > (this.config.maxRequestBytes ?? CODEX_REQUEST_BODY_LIMIT_BYTES)) {
      throw new ModelProviderError("完整模型请求超过当前字节上限", "protocol");
    }
    const send = async (): Promise<ChatResult> => {
      const result = await plan.execute({ signal: opts.signal }).catch((error: unknown) => {
        if (error instanceof Error) Object.assign(error, { requestHash: plan.requestHash, requestedModel: plan.model });
        throw error;
      });
      return {
        text: result.content,
        modelId: result.model,
        promptTokens: result.usage.prompt_tokens,
        completionTokens: result.usage.completion_tokens,
        reasoningTokens: result.usage.completion_tokens_details?.reasoning_tokens ?? 0,
        finishReason: "stop",
        requestHash: plan.requestHash,
        responseHash: result.responseHash,
        responseId: result.providerRequestId,
        scene, mode: "enabled", effort: result.effort,
        outputCeiling: plan.budget.outputCeiling,
        inputTokenEstimate: plan.budget.inputTokens,
        inputTokenUpperBound: plan.upperBound.inputTokens,
        inputTokenBasis: CODEX_INPUT_TOKEN_BASIS,
        imageCount: input.reduce((count, message) => count + (Array.isArray(message.content)
          ? message.content.filter(part => part.type === "image_url").length : 0), 0),
        policyVersion: TEXT_PRIMARY_POLICY_VERSION,
        registryVersion: registration.registryVersion,
        attempts: [],
      };
    };
    return this.config.guard ? this.config.guard(plan, send) : send();
  }
}
