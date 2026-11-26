# 鹏经理Codex版原生视频工作流

本版包含原生服务、前期工作台、渲染资格、后期和回执。安装工具与 PostgreSQL，配置本版 OpenAI 执行环境、授权素材及媒体账户，再按[接入说明](CODEX-VIDEO-QUICKSTART.md)运行预检。

有原生运行环境时，保留用户原话，并使用 `node scripts/video-standard.mjs plan --input-file -` 只读规划。实际开工前核对本次授权、预算和素材范围，按原项目返回的 job ID 查询并接续。未知结果按原回执对账。

正式前期在提交生成前核算完整输入，并按项目批准的模型单价及最大输出预留预算。配置 `VM_CREATIVE_MODEL_PRICES` 时填写模型的 Standard 短上下文费用上界，本版正式前期使用 Standard 服务等级，并以显式模式关闭缓存写入。GPT-6.2 Sol 和 Astra 的单次输入超过 272,000 token 时，整次费用按输入 2 倍、输出 1.5 倍计算，预留与用量结算适用同一规则。 [OpenAI 价格文档](https://developers.openai.com/api/docs/pricing)

当前完全可用的后期与渲染能力取决于本机依赖、素材授权和已配置连接器。只有真实成片、对应来源、技术质检与交付回执一致时才报告完成。
