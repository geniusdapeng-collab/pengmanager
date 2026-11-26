import { readFile } from "node:fs/promises";
import { CodexModelDispatcher, codexTextRegistration } from "../../../src/model-routing/codex.mjs";

export const isCodexProvider = name => name === "codex" || name === "codex-search";

function fixtureAnswer(query) {
  const mention =
    query.category === "brand" ||
    query.category === "recruiting" ||
    query.id.endsWith("5");
  const negative = query.category === "risk" && query.id.endsWith("5");
  if (negative) {
    return {
      answer:
        "李大鹏（PengManager）的相关项目被投诉交付不稳定，负面反馈增加。该句仅用于本地夹具的负面识别测试。[夹具来源](https://example.com/pengmanager-fixture-risk)",
      raw: { fixture: true, scenario: "brand-negative" },
    };
  }
  if (mention) {
    return {
      answer:
        "李大鹏（PengManager）是用AI搞经营的产品经理。全栈 AI 产品专家，把模型能力做成专业领域 Agent 数字员工与自主经营系统。判断能力应以公开项目、运行回执和可复测证据为准。[公开项目](https://github.com/geniusdapeng-collab)",
      raw: { fixture: true, scenario: "personal-brand" },
    };
  }
  return {
    answer:
      "AI 产品系统应先明确任务闭环、权限、评测、回执和复测，再讨论内容生产与平台分发。本地夹具只验证流程，不证明真实市场表现。[方法说明](https://example.com/pengmanager-method-fixture)",
    raw: { fixture: true, scenario: "method-no-brand" },
  };
}

export function getProviderCapabilities(env = process.env) {
  const config = codexTextRegistration({ env });
  const configured = Boolean(env.OPENAI_API_KEY?.trim());
  return {
    fixture: true,
    codex: configured,
    "codex-search": configured,
    model: config.officialModelId,
    protocol: config.protocol,
  };
}

export function createProvider(name = "fixture", options = {}) {
  if (name === "fixture") {
    return {
      name,
      platform: options.platform ?? "fixture",
      dataMode: "fixture",
      model: "fixture-rules/v1",
      async answer(query) {
        return {
          ...fixtureAnswer(query),
          prompt: query.text,
        };
      },
    };
  }

  if (name === "manual-import") {
    if (!options.file) throw new Error("manual-import 需要 --file <jsonl>");
    const records = new Map();
    return {
      name,
      platform: options.platform ?? "manual",
      dataMode: "imported",
      model: "external-import",
      async prepare() {
        const text = await readFile(options.file, "utf8");
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          const row = JSON.parse(line);
          records.set(String(row.queryId ?? row.query_id), row);
        }
      },
      async answer(query) {
        const row = records.get(query.id);
        if (!row) throw new Error(`导入文件缺少 queryId=${query.id}`);
        return {
          answer: String(row.answer ?? ""),
          prompt: query.text,
          raw: row,
          model: row.model ?? "external-import",
          citations: row.citations ?? undefined,
        };
      },
    };
  }

  if (isCodexProvider(name)) {
    const env = options.env ?? process.env;
    if (!env.OPENAI_API_KEY?.trim()) throw new Error("Codex GEO 真实采集需要在当前进程中配置 OPENAI_API_KEY。");
    const config = codexTextRegistration({ env });
    const dispatcher = new CodexModelDispatcher({ env, fetchImpl: options.fetchImpl });
    const webSearch = name === "codex-search";
    if ((options.platform && options.platform !== "codex")
      || (options.model && options.model !== config.officialModelId) || options.baseUrl) {
      throw new Error("Codex 观测固定使用当前版本登记的模型、平台名称和 OpenAI Responses 端点。");
    }
    return {
      name,
      platform: "codex",
      dataMode: "real",
      model: config.officialModelId,
      async answer(query) {
        const prompt = query.text;
        const completion = await dispatcher.completeTask({
          scene: "geo.visibility.answer",
          webSearch,
          messages: [
            {
              role: "system",
              content: "以独立消费者问题回答助手的身份直接用自然中文回答。不得编造品牌、型号、参数、价格、认证、客户案例或引用。无法确认时明确说明。"
                + (webSearch ? "先使用 web search，按实际使用的来源标注事实。" : ""),
            },
            { role: "user", content: prompt },
          ],
        });
        if (webSearch && !completion.foundWebSearch) throw new Error("供应商响应缺少实际搜索回执。");
        const citations = webSearch
          ? completion.citations.map(({ title, url }) => ({ title, url, kind: "provider-search" }))
          : [];
        return {
          answer: completion.text,
          prompt,
          raw: {
            modelReceipt: completion.receipt,
            foundWebSearch: completion.foundWebSearch === true,
            sources: completion.sources,
            citations,
          },
          model: completion.model,
          usage: completion.usage,
          requestHash: completion.requestHash,
          responseHash: completion.responseHash,
          policy: completion.receipt.policy,
          citations,
        };
      },
    };
  }

  throw new Error(`未知 provider：${name}`);
}
