export const CODEX_MODEL_IDS = Object.freeze(["gpt-6.2-sol", "gpt-6.2-astra"]);

// OpenAI Standard pricing applies the long-context tier to the entire request.
export function codexLongContextBilling(model, inputTokens) {
  return CODEX_MODEL_IDS.includes(model) && inputTokens > 272_000;
}
