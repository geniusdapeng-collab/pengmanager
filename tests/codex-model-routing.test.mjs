import test from "node:test";
import assert from "node:assert/strict";
import { CODEX_DEFAULT_MODEL, CodexModelDispatcher, prepareCodexText } from "../src/model-routing/codex.mjs";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { hashText } from "../src/domain/hash.mjs";

const env = { OPENAI_API_KEY: "fixture-only" };
const messages = [{ role: "user", content: "Respond with a JSON object." }];
function fixture(options = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, request) => {
    const body = JSON.parse(request.body);
    calls.push({ url, request, body });
    if (url.endsWith("/input_tokens")) {
      return Response.json({ object: "response.input_tokens", input_tokens: 214, ...options.count });
    }
    if (options.throwGeneration) throw new TypeError("network closed");
    const content = options.content ?? '{"title":"A fictional title"}';
    return Response.json({
      id: "resp_fixture",
      model: CODEX_DEFAULT_MODEL,
      status: "completed",
      usage: { input_tokens: 214, output_tokens: 40, total_tokens: 254,
        input_tokens_details: { cached_tokens: 50 }, output_tokens_details: { reasoning_tokens: 12 } },
      output: [{ type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: content }] }],
      ...options.generation,
    });
  } };
}

test("Codex dispatcher exact-counts the image and JSON input, binds the generation wire, and prevents replay", async () => {
  const { calls, fetchImpl } = fixture();
  const dispatcher = new CodexModelDispatcher({ env, fetchImpl });
  const prepared = await dispatcher.prepareTask({
    scene: "visual.plan", maxOutputTokens: 512,
    messages: [{ role: "user", content: [{ type: "text", text: "Inspect authorized artwork." },
      { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=", detail: "high" } }] }],
  });
  assert.equal(calls.length, 1);
  assert.equal(prepared.budget.inputTokens, 214);
  assert.equal(prepared.budget.outputCeiling, 512);
  assert.equal(prepared.provider, "openai");
  const done = await prepared.execute();
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses/input_tokens");
  assert.equal(calls[1].url, "https://api.openai.com/v1/responses");
  assert.deepEqual(calls[1].body.input, calls[0].body.input);
  assert.equal(calls[1].body.input[1].content[1].type, "input_image");
  assert.equal(calls[1].body.max_output_tokens, 512);
  assert.equal(calls[1].body.truncation, "disabled");
  assert.equal(calls[1].body.store, false);
  assert.equal(calls[1].body.service_tier, "default");
  assert.deepEqual(calls[1].body.prompt_cache_options, { mode: "explicit" });
  assert.equal(calls[1].request.redirect, "error");
  assert.equal(prepared.wireSha256, hashText(calls[1].request.body));
  assert.equal(done.receipt.wireSha256, prepared.wireSha256);
  assert.equal(done.receipt.requestHash, prepared.requestHash);
  assert.equal(done.receipt.registry.requestedModel, CODEX_DEFAULT_MODEL);
  assert.equal(done.receipt.registry.returnedModel, CODEX_DEFAULT_MODEL);
  assert.equal(done.receipt.usage.reasoningTokens, 12);
  assert.deepEqual(done.value, { title: "A fictional title" });
  await assert.rejects(prepared.execute(), { code: "MODEL_DISPATCH_REPLAY_BLOCKED" });
  assert.equal(calls.length, 2);
});

test("Codex metering denies invalid model, missing auth, over-window input, and remote images before generation", async () => {
  const { calls, fetchImpl } = fixture({ count: { input_tokens: 922_001 } });
  await assert.rejects(prepareCodexText({ env: {}, messages, fetchImpl }), { code: "MODEL_CREDENTIAL_MISSING" });
  await assert.rejects(prepareCodexText({ env, model: "deepseek-flash", messages, fetchImpl }), { code: "MODEL_ID_NOT_ALLOWED" });
  await assert.rejects(prepareCodexText({ env, messages: [{ role: "user", content: [
    { type: "image_url", image_url: { url: "https://example.com/private.png" } },
  ] }], fetchImpl }), { code: "MODEL_INPUT_CONTENT_UNSUPPORTED" });
  await assert.rejects(prepareCodexText({ env, messages, maxRequestBytes: 16, fetchImpl }),
    { code: "MODEL_REQUEST_BODY_TOO_LARGE" });
  assert.equal(calls.length, 0);
  await assert.rejects(prepareCodexText({ env, messages, fetchImpl }), { code: "MODEL_CONTEXT_EXCEEDED" });
  assert.equal(calls.length, 1);
});

test("known incomplete and invalid structured outputs retain usage, unknown dispatch failures stay unresolved", async () => {
  for (const [options, expected] of [
    [{ generation: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }, "MODEL_OUTPUT_TRUNCATED"],
    [{ content: '{"title":"one","title":"two"}' }, "MODEL_OUTPUT_SCHEMA_INVALID"],
    [{ content: "[]" }, "MODEL_OUTPUT_SCHEMA_INVALID"],
  ]) {
    const { fetchImpl } = fixture(options);
    const prepared = await prepareCodexText({ env, messages, responseFormat: "json_object", fetchImpl });
    await assert.rejects(prepared.execute(), error => error.code === expected && !error.unknown
      && error.metering.outputTokens === 40 && error.providerRequestId === "resp_fixture");
  }
  for (const [options, expected] of [
    [{ generation: { model: "different-model" } }, "MODEL_IDENTITY_CHANGED"],
    [{ generation: { usage: null } }, "MODEL_USAGE_INVALID"],
    [{ generation: { service_tier: "priority" } }, "MODEL_SERVICE_TIER_CHANGED"],
    [{ throwGeneration: true }, "MODEL_NETWORK_UNKNOWN"],
  ]) {
    const { calls, fetchImpl } = fixture(options);
    const prepared = await prepareCodexText({ env, messages, fetchImpl });
    await assert.rejects(prepared.execute(), error => error.code === expected && error.unknown === true);
    assert.equal(calls.length, 2);
  }
});

test("Codex GEO search attributes only provider citations from completed tool execution", async () => {
  const outputText = { type: "output_text", text: "Example answer https://irrelevant.test/",
    annotations: [{ type: "url_citation", url: "https://example.com/verified", title: "Verified" }] };
  const output = [{ type: "web_search_call", status: "completed",
    action: { sources: [{ url: "https://example.com/verified" }, { url: "https://example.com/opened-only" }, { url: "https://name:secret@invalid.test/" }] } },
  { type: "message", role: "assistant", status: "completed", content: [outputText] }];
  const { calls, fetchImpl } = fixture({ generation: { output } });
  const adapter = new CodexAdapter({ env, fetchImpl });
  const evidence = await adapter.answerQuery({ id: "Q-fictional", text: "What can we confirm?", locale: "en" });
  assert.deepEqual(calls[1].body.tools, [{ type: "web_search" }]);
  assert.deepEqual(evidence.citations, [{ url: "https://example.com/verified", title: "Verified", domain: "example.com" }]);
  assert.equal(evidence.evidence.transport, "openai-responses");
  assert.equal((await adapter.search("evidence query")).results.length, 2);
  const noSearch = fixture({ generation: { output: output.slice(1) } });
  await assert.rejects(new CodexAdapter({ env, fetchImpl: noSearch.fetchImpl }).search("evidence query"),
    { code: "MODEL_SEARCH_EVIDENCE_MISSING" });
});
