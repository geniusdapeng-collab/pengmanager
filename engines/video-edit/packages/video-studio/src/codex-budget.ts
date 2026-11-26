import { CodexTextProvider, CODEX_INPUT_TOKEN_BASIS } from "@workloom/base/model-router";
import { assertCreativeBudgetCurrent, creativeBudgetActive, guardedCreativeModelCall, type CreativeModelOutcome } from "./creative-runtime.js";

interface ResponsesFailure {
  httpStatus?: number;
  providerRequestId?: string;
  metering?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; reasoningTokens?: number };
  responseHash?: string;
  receipt?: { responseHash?: string; usage?: ResponsesFailure["metering"] };
}

function failureOutcome(error: unknown): CreativeModelOutcome {
  const failure = error as ResponsesFailure | null | undefined;
  const usage = failure?.receipt?.usage;
  const metered = [usage?.inputTokens, usage?.outputTokens, usage?.totalTokens].every(Number.isSafeInteger);
  return {
    usageKnown: metered,
    success: false,
    ...(metered ? usage : {}),
    failureClass: failure?.httpStatus ? "http_error" : "outcome_unknown",
    httpStatus: failure?.httpStatus,
    providerRequestId: failure?.providerRequestId,
    responseHash: failure?.receipt?.responseHash ?? failure?.responseHash,
  };
}

/** Reserve after provider input counting and before starting the paid response. */
export function budgetCodexProvider(provider: CodexTextProvider): CodexTextProvider {
  if (!creativeBudgetActive()) return provider;
  return provider.withGuard((plan, send) => guardedCreativeModelCall({
    model: plan.model,
    requestHash: plan.requestHash,
    inputChars: plan.requestBytes,
    requestBytes: plan.requestBytes,
    inputTokenEstimate: plan.budget.inputTokens,
    inputTokenUpperBound: plan.upperBound.inputTokens,
    inputTokenBasis: CODEX_INPUT_TOKEN_BASIS,
    maxOutputTokens: plan.budget.outputCeiling,
  }, send, result => ({
    success: true,
    usageKnown: true,
    inputTokens: result.promptTokens,
    outputTokens: result.completionTokens,
    totalTokens: result.promptTokens + result.completionTokens,
    reasoningTokens: result.reasoningTokens,
    finishReason: result.finishReason,
    providerRequestId: result.responseId ?? undefined,
    responseHash: result.responseHash,
  }), failureOutcome), assertCreativeBudgetCurrent);
}
