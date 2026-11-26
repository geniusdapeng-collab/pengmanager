import { describe, expect, it } from "vitest";
import { assertCreativeConfigurationReady, creativeConfigurationPreflight, creativeModelCostMicros } from "./creative-config.js";

const valid = {
  VM_CREATIVE_BUDGET_CNY: "12.5",
  VM_CREATIVE_MAX_CALLS: "40",
  VM_CREATIVE_MAX_TOKENS: "200000",
  VM_CREATIVE_MAX_WALL_MS: "600000",
  VM_CREATIVE_MODEL_PRICES: JSON.stringify({
    "deepseek-flash": { inputCnyPerMillion: 1.5, outputCnyPerMillion: 3.5 },
  }),
};

describe("creative budget preflight", () => {
  it("fails closed and reports every absent creative budget key", () => {
    const result = creativeConfigurationPreflight({}, "deepseek-flash");
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual([
      "VM_CREATIVE_BUDGET_CNY",
      "VM_CREATIVE_MAX_CALLS",
      "VM_CREATIVE_MAX_TOKENS",
      "VM_CREATIVE_MAX_WALL_MS",
      "VM_CREATIVE_MODEL_PRICES",
    ]);
    expect(() => assertCreativeConfigurationReady({}, "deepseek-flash")).toThrow(/missing=VM_CREATIVE_BUDGET_CNY/);
  });

  it("accepts a complete positive budget and preserves exact integer ceilings", () => {
    const result = creativeConfigurationPreflight(valid, "deepseek-flash");
    expect(result).toMatchObject({
      ready: true,
      model: "deepseek-flash",
      budget: {
        maxMicros: 12_500_000,
        maxCalls: 40,
        maxTokens: 200_000,
        maxWallMs: 600_000,
        price: { inputCnyPerMillion: 1.5, outputCnyPerMillion: 3.5 },
      },
    });
  });

  it("rejects malformed prices, absent model prices and unsafe ceilings", () => {
    expect(creativeConfigurationPreflight({ ...valid, VM_CREATIVE_MODEL_PRICES: "{" }, "deepseek-flash"))
      .toMatchObject({ ready: false, invalid: ["VM_CREATIVE_MODEL_PRICES"] });
    expect(creativeConfigurationPreflight(valid, "another-model"))
      .toMatchObject({ ready: false, invalid: ["VM_CREATIVE_MODEL_PRICES"] });
    expect(creativeConfigurationPreflight({ ...valid, VM_CREATIVE_MAX_CALLS: "1.5" }, "deepseek-flash"))
      .toMatchObject({ ready: false, invalid: ["VM_CREATIVE_MAX_CALLS"] });
  });
});


describe("creative model cost policy", () => {
  it.each(["gpt-6.2-sol", "gpt-6.2-astra"])("prices the full %s request at the measured input tier", model => {
    const price = { inputCnyPerMillion: 2.5, outputCnyPerMillion: 10 };
    const reservation = creativeModelCostMicros(272_001, 40, price, model);
    expect(reservation).toBe(1_360_605);
    expect(creativeModelCostMicros(272_001, 3, price, model)).toBe(1_360_050);
    expect(creativeModelCostMicros(272_000, 3, price, model)).toBe(680_030);
    expect(creativeModelCostMicros(272_001, 3, price)).toBe(680_033);
  });
});
