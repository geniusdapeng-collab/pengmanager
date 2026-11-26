import { afterEach, describe, expect, test, vi } from "vitest";
import { CODEX_INPUT_TOKEN_BASIS, CodexTextProvider, routeSmart } from "@workloom/base/model-router";
import { withCreativeBudget, type CreativeModelOutcome } from "./creative-runtime.js";
import { completeVideoTextTask, videoTextEndpointFromEnv, type VideoTextMessage } from "./video-text-client.js";

const model = "gpt-6.2-sol";
const env = Object.freeze({
  LLM_PROVIDER: "codex", LLM_MODEL: model, PENGMANAGER_CODEX_MODEL: model, OPENAI_API_KEY: "isolated-test-key",
  DEEPSEEK_API_KEY: "unusable-legacy-key", LLM_BASE_URL: "https://old-model.example.test",
});

const messages: VideoTextMessage[] = [{ role: "user", content: [
  { type: "text", text: "核对已授权图像并返回 JSON" },
  { type: "image_url", image_url: { url: "data:image/png;base64,YWJj", detail: "high" } },
] }];

function providerFixture({ content = '{"approved":true}', completionModel = model } = {}) {
  const count = vi.fn();
  const generate = vi.fn();
  const mock = vi.fn<typeof fetch>().mockImplementation(async (url, request) => {
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer isolated-test-key");
    const body = JSON.parse(String(request?.body));
    expect(body.model).toBe(model);
    expect(body.truncation).toBe("disabled");
    if (String(url).endsWith("/responses/input_tokens")) {
      count(body);
      return Response.json({ object: "response.input_tokens", input_tokens: 128 });
    }
    expect(url).toBe("https://api.openai.com/v1/responses");
    generate(body);
    return Response.json({
      id: "resp_isolated_video", model: completionModel, status: "completed",
      output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: content }] }],
      usage: { input_tokens: 128, output_tokens: 12, total_tokens: 140, output_tokens_details: { reasoning_tokens: 7 } },
    });
  });
  return { mock, count, generate };
}

const task = (fetchImpl: typeof fetch) => completeVideoTextTask({
  endpoint: videoTextEndpointFromEnv(env)!, scene: "video.quality.producer-review", messages, requireJson: true, fetchImpl,
});

describe("embedded Codex text routing", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("structured vision runs under a measured, provider-enforced reservation", async () => {
    const fixture = providerFixture();
    const beforeModelCall = vi.fn();
    const afterModelCall = vi.fn();
    const result = await withCreativeBudget({
      beforeModelCall: async request => {
        expect(fixture.count).toHaveBeenCalledTimes(1);
        expect(fixture.generate).not.toHaveBeenCalled();
        beforeModelCall(request);
        return "reservation";
      },
      afterModelCall: async (reservation, outcome) => { afterModelCall(reservation, outcome); },
    }, () => task(fixture.mock));
    expect(result).toMatchObject({ value: { approved: true }, model, finishReason: "stop",
      responseId: "resp_isolated_video", inputTokenBasis: CODEX_INPUT_TOKEN_BASIS,
      usage: { inputTokens: 128, outputTokens: 12, reasoningTokens: 7 } });
    expect(beforeModelCall).toHaveBeenCalledWith(expect.objectContaining({
      model, inputTokenUpperBound: 128, maxOutputTokens: result.outputCeiling, inputTokenBasis: CODEX_INPUT_TOKEN_BASIS,
    }));
    expect(afterModelCall).toHaveBeenCalledWith("reservation", expect.objectContaining({
      usageKnown: true, success: true, inputTokens: 128, outputTokens: 12, totalTokens: 140,
    }));
    expect(fixture.generate).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.arrayContaining([expect.objectContaining({ role: "user",
        content: expect.arrayContaining([{ type: "input_image", image_url: "data:image/png;base64,YWJj", detail: "high" }]) })]),
      store: false, max_output_tokens: result.outputCeiling, reasoning: { effort: "high" },
    }));
  });

  test("insufficient budget stops before generation and unconfirmed identities preserve the hold", async () => {
    const fixture = providerFixture({ completionModel: "unexpected-model" });
    await expect(withCreativeBudget({
      beforeModelCall: async () => { throw new Error("budget denied"); },
      afterModelCall: async () => { throw new Error("unexpected settlement"); },
    }, () => task(fixture.mock))).rejects.toThrow("budget denied");
    expect(fixture.generate).not.toHaveBeenCalled();

    const outcomes: CreativeModelOutcome[] = [];
    await expect(withCreativeBudget({
      beforeModelCall: async () => "reservation",
      afterModelCall: async (_reservation, outcome) => { outcomes.push(outcome); },
    }, () => task(fixture.mock))).rejects.toMatchObject({ code: "CREATIVE_USAGE_UNKNOWN" });
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ usageKnown: false, success: false });
  });

  test("invalid model JSON settles known usage before offering the guarded schema repair evidence", async () => {
    const fixture = providerFixture({ content: '{"approved":true,"approved":false}' });
    const outcomes: CreativeModelOutcome[] = [];
    await expect(withCreativeBudget({
      beforeModelCall: async () => "reservation",
      afterModelCall: async (_reservation, outcome) => { outcomes.push(outcome); },
    }, () => task(fixture.mock))).rejects.toMatchObject({ code: "MODEL_OUTPUT_SCHEMA_INVALID",
      options: { unknown: false, jsonFailure: { kind: "invalid_json", model, responseId: "resp_isolated_video" } } });
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    expect(outcomes).toMatchObject([{ usageKnown: true, success: false, totalTokens: 140 }]);
  });

  test("the digital employee router uses the same model and reports the actual GPT reasoning mode", async () => {
    vi.stubEnv("LLM_PROVIDER", "codex");
    vi.stubEnv("PENGMANAGER_CODEX_MODEL", model);
    const fixture = providerFixture();
    const provider = new CodexTextProvider({ env, fetchImpl: fixture.mock });
    const recordModelTrace = vi.fn();
    const sink = { recordModelTrace, recordDegradation: vi.fn(), recordCircuitBreak: vi.fn() };
    const answer = await routeSmart({ action: "video", scene: "video.deterministic", forceModel: model, messages },
      new Map([[model, provider]]), sink);
    expect(answer.kind).toBe("answered");
    expect(recordModelTrace).toHaveBeenCalledWith(expect.objectContaining({ model_id: model, mode: "enabled",
      effort: "low", responseId: "resp_isolated_video" }));
    await expect(routeSmart({ action: "video", forceModel: "deepseek-flash", messages }, new Map([[model, provider]]), sink))
      .rejects.toThrow("TEXT_PRIMARY_MODEL_MISMATCH");
    expect(fixture.generate).toHaveBeenCalledTimes(1);
  });
});
