import { scanSensitiveText } from "../domain/policy.mjs";
import { MAIN_PROFILE, SYSTEM_IDENTITY } from "../domain/identity.mjs";
import { PRODUCT_NAMING_PROMPT } from "../domain/product-naming.mjs";

function validateGeneratedContent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("模型没有返回 JSON 对象。");
  }
  const allowed = new Set(["title", "body", "hook", "cta", "hashtags"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`模型返回未声明字段：${key}`);
  }
  if (typeof value.title !== "string" || !value.title.trim()) {
    throw new Error("模型没有返回有效的 title。");
  }
  if (typeof value.body !== "string" || !value.body.trim()) {
    throw new Error("模型没有返回有效的 body。");
  }
  if (value.hook !== undefined && typeof value.hook !== "string") {
    throw new Error("模型返回的 hook 无效。");
  }
  if (value.cta !== undefined && typeof value.cta !== "string") {
    throw new Error("模型返回的 cta 无效。");
  }
  if (value.hashtags !== undefined
    && (!Array.isArray(value.hashtags) || value.hashtags.some((item) => typeof item !== "string"))) {
    throw new Error("模型返回的 hashtags 无效。");
  }
  return value;
}

export async function generateModelContent(dispatcher, { brief, claims, platform, contentType = "social_post" }) {
  const claimText = claims.map((claim) => `- ${claim.id}: ${claim.text}`).join("\n");
  const prompt = [
    `请为${SYSTEM_IDENTITY.nameZh} / ${SYSTEM_IDENTITY.nameEn}的主账号生成一条可审核的平台内容草案。`,
    `中文账号名：${MAIN_PROFILE.nameZh}；英文账号名：${MAIN_PROFILE.nameEn}。`,
    `中文展示名：${MAIN_PROFILE.displayNameZh}；英文展示名：${MAIN_PROFILE.displayNameEn}。`,
    `中文简介：${MAIN_PROFILE.bioZh}`,
    `英文简介：${MAIN_PROFILE.bioEn}`,
    "只使用给定 Claim，不得补造客户、数字、奖项、雇佣关系或合作方。",
    "不使用“行业第一”“AI大师”“颠覆世界”等自封表达。",
    `目标平台：${platform}`,
    `内容类型：${contentType}`,
    `任务：${brief}`,
    "事实：",
    claimText,
    "",
    "严格只输出一个 JSON 对象，字段为 title、body、hook、cta、hashtags。",
    "body 使用自然中文，控制在 300 至 800 字。",
  ].join("\n");
  const result = await dispatcher.completeTask({
    scene: "content.draft",
    messages: [
      {
        role: "system",
        content: `你是有事实边界的 GEO 内容编辑。${PRODUCT_NAMING_PROMPT}只输出合法 JSON，不得输出 Markdown 围栏或解释。`,
      },
      { role: "user", content: prompt },
    ],
  });
  const generated = validateGeneratedContent(result.value);
  const sensitive = scanSensitiveText(
    `${generated.title}\n${generated.body}\n${generated.cta ?? ""}`,
  );
  if (sensitive.length > 0) {
    throw new Error("模型生成内容包含敏感信息，已拒绝保存。");
  }
  return {
    ...generated,
    model: result.model,
    responseId: result.responseId,
    usage: result.usage,
    responseHash: result.responseHash,
    requestHash: result.requestHash,
    policy: result.receipt.policy,
    finishReason: result.finishReason,
    mode: result.mode,
    effort: result.effort,
    outputCeiling: result.outputCeiling,
    policyHash: result.policyHash,
    registryVersion: result.registryVersion,
    attempts: result.attempts,
    receipt: result.receipt,
  };
}
