import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBudget, reserveBudget, upperBoundCost } from "../src/domain/content-ops-budget.mjs";

const now = new Date("2026-11-26T00:00:00Z");
const expiration = "2026-11-27T00:00:00Z";
const outputTokens = 128_000;

function solPricing() {
  return {
    hash: "a".repeat(64), provider: "openai", model: "gpt-6.2-sol", currency: "USD", expiresAt: expiration,
    inputCostMicrosPerMillion: 2_000_000, outputCostMicrosPerMillion: 10_000_000, requestCostMicros: 17,
  };
}

test("Codex long-context pricing applies to the full request for Sol and Astra", () => {
  const sol = solPricing();
  const astra = { ...sol, model: "gpt-6.2-astra", inputCostMicrosPerMillion: 8_000_000,
    outputCostMicrosPerMillion: 40_000_000 };
  assert.equal(upperBoundCost(sol, { inputTokens: 272_000, outputTokens }), 1_824_017);
  assert.equal(upperBoundCost(sol, { inputTokens: 272_001, outputTokens }), 3_008_021);
  assert.equal(upperBoundCost(astra, { inputTokens: 272_000, outputTokens }), 7_296_017);
  assert.equal(upperBoundCost(astra, { inputTokens: 272_001, outputTokens }), 12_032_033);
  assert.equal(upperBoundCost({ ...sol, provider: "isolated_fixture" }, { inputTokens: 272_001, outputTokens }), 1_824_019);
  assert.equal(upperBoundCost({ ...sol, model: "previous-model" }, { inputTokens: 272_001, outputTokens }), 1_824_019);
});

test("long-context output rounds the multiplied rate up and rejects unsafe totals", () => {
  const pricing = { ...solPricing(), inputCostMicrosPerMillion: 0, outputCostMicrosPerMillion: 666_667, requestCostMicros: 0 };
  assert.equal(upperBoundCost(pricing, { inputTokens: 272_001, outputTokens: 1 }), 2);
  assert.throws(() => upperBoundCost({ ...pricing, inputCostMicrosPerMillion: Number.MAX_SAFE_INTEGER },
    { inputTokens: 922_000, outputTokens: 1 }), { code: "PRICING_REQUIRED" });
});

test("a long request exceeding the authorized model cost creates no reservation", () => {
  const pricing = solPricing();
  const makeState = maxCostMicros => {
    const authorization = normalizeBudget({
      name: "Isolated price-boundary check", currency: "USD", deadlineAt: expiration, pricingSnapshot: pricing,
      maxCalls: 1, maxInFlight: 1, maxCostMicros, maxInputTokens: 300_000, maxPerCallInputTokens: 300_000,
      maxOutputTokens: outputTokens, maxPerCallOutputTokens: outputTokens, maxNativeProcesses: 0, maxRenderSeconds: 0, maxTempBytes: 0,
    }, { id: "budget", now, actor: "fixture", pricing });
    return { modelBudgetAuthorizations: [authorization], modelPricingSnapshots: [pricing], modelBudgetReservations: [] };
  };
  const reserve = (state, inputTokens) => reserveBudget(state, {
    job: { id: "job", budgetAuthorizationId: "budget" },
    task: { taskId: "task", costClass: "model", budgetAuthorizationHash: state.modelBudgetAuthorizations[0].authorizationHash },
    attempt: { id: "attempt" }, now, reservationId: "reservation",
    input: {
      callKey: "model.1", requestHash: "b".repeat(64), provider: pricing.provider, model: pricing.model,
      pricingSnapshotHash: pricing.hash, upperBound: { inputTokens, outputTokens, nativeProcesses: 0, renderSeconds: 0, tempBytes: 0 },
    },
  });

  const shortOnly = makeState(1_824_019);
  assert.throws(() => reserve(shortOnly, 272_001),
    error => error.code === "JOB_BUDGET_EXCEEDED" && error.details.dimension === "maxCostMicros");
  assert.deepEqual(shortOnly.modelBudgetReservations, []);
  assert.equal(reserve(shortOnly, 272_000).reserved.costMicros, 1_824_017);
  assert.equal(reserve(makeState(3_008_021), 272_001).reserved.costMicros, 3_008_021);
});
