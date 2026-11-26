# Codex 版内容生产工位

内容工位根据已冻结的任务、原文和授权素材运行策划、编辑、翻译与独立审稿。数字员工都使用同一个登记的 OpenAI 模型。渲染、导出和交付仍由具体任务的审批与验收规则控制。

1. 在站点建立并审批准确的预算授权。价格快照需对应 `openai`、当前登记的模型、币种和 Standard 短上下文费率。`inputCostMicrosPerMillion` 可用 Standard 非缓存输入单价或已批准的更高上界。内容工位使用显式缓存模式且不设写入断点，输入上界覆盖实际缓存读取费率。给覆盖范围登记 `cacheChargedAtInputUpperBound` 和 `reasoningIncludedInOutput`。 [OpenAI 官方定价](https://developers.openai.com/api/docs/pricing) · [提示缓存](https://developers.openai.com/api/docs/guides/prompt-caching)
2. 运行 `node scripts/content-ops-worker.mjs bindings`，把实际源码绑定登记到工位授权。升级更改工作代码时，按原配对流程授权这份新的绑定。
3. 在现有私有工位配置的 `model` 下填写 `contextTokenLimit`、官方文档 `contextProof`、获准价格快照的 `pricingSnapshotHash` 和 `currency`。模型由同一产品配置的 `PENGMANAGER_CODEX_MODEL` 解析。配置指定 `model` 或 `provider` 时必须与该选择一致。由 [OpenAI 模型目录](https://developers.openai.com/api/docs/models) 核对所选模型的上下文和输出上限。
4. 在工位进程提供 `OPENAI_API_KEY` 和 `CONTENT_OPS_WORKER_TOKEN`。首次配对另需一次性 `CONTENT_OPS_PAIRING_CHALLENGE`。用 `node scripts/content-ops-worker.mjs doctor --config <绝对路径>` 检查本地配置与适配器状态，完成配对后用 `node scripts/content-ops-worker.mjs run --config <绝对路径>` 领取工单。

工位用 OpenAI 输入计量接口获取同一完整请求的输入 token 数，再根据预留边界申请预算额度。GPT-6.2 Sol 和 Astra 在输入超过 272,000 token 时，预算将整次请求的输入上界按 2 倍、输出上界按 1.5 倍计算，精确向上取整到微货币单位。预算批准后只发出一次生成，费用以授权快照和供应商用量处理。结果不明时保留原请求、租约与预算供对账。发布权限留在站点相应的受控流程。 [OpenAI 输入计量接口](https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count)
