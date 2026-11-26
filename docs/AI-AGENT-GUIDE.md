# 鹏经理Codex版接入指南

在当前检出目录运行 `pnpm agent:guide`，或调用 MCP `pengmanager_agent_guide`，完整读取返回的文档。使用 `node scripts/agent.mjs list` 或 MCP `tools/list` 查看可用能力。外层 Codex 使用自己的登录，实际模型请求由配置了 `OPENAI_API_KEY` 的鹏经理应用或授权工位发出。 [Codex 接入配置](AI-WORKBENCH-SETUP.md) · [部署说明](DEPLOYMENT.md)

## 图文和独立图片

1. 通过 `pengmanager_editorial_plan` 传入 `{"brief":{"intent":"用户原话"}}`。返回任务类型、所需输入和 `originalIntent`。若路线是视频，转入原生视频工作流。
2. 为 Agent 配置所有者运行的本机工作台地址，如 `PENGMANAGER_EDITORIAL_ORIGIN=http://127.0.0.1:4318`。使用 `pengmanager_editorial_status` 确认实例和创作总控可用。启用了管理员登录的实例继续从登录后的创作总控操作。
3. 使用 `pengmanager_editorial_job_create` 登记图文任务。`brief` 保留原话，填入已确定的 `explicitKind`（`article`、`article_visual`、`pure_visual` 之一）与已核对的素材和 Claim 引用。`idempotencyKey` 对应这次原始登记，重试沿用同一键与请求。此步骤只生成任务记录。
4. 用 `pengmanager_editorial_job_get` 读取原 `jobId` 和 `etag`。确认用户授权这次模型、费用及素材用途后，用 `pengmanager_editorial_job_dispatch` 传入 `jobId`、本次读取的完整 `ifMatch`、稳定的 `idempotencyKey` 和 `confirmProduction: true`。状态未知时先回读同一任务。服务中断后，只有读到可安全续办的状态才使用当前 ETag 继续原任务。
5. 从原任务核对稿件、配图、审核发现和实际产物。候选转原文修订、账号或官网发布均使用[编辑出版工作流](CONTENT-PUBLISHING.md)的权限、审核和回读。跨平台图文制作在管理台建立计划及预算后，由已配对的[内容生产工位](CONTENT-OPS-WORKER.md)领取工作单，沿原租约读回。 [AI 审核工位](AI-APPROVAL.md)

Shell 与 MCP 使用相同入口和入参。以下命令只规划图文，并输出应使用的生产线。

```bash
printf '%s\n' '{"brief":{"intent":"写一篇编辑流程说明，并画一张配图"}}' |
  node scripts/agent.mjs invoke pengmanager.editorial.plan --input-file -
```

## 原生视频

保留用户指令原文，先调用 `pengmanager_video_workflow` 和 `pengmanager_video_preflight`。使用当前检出目录生成的标准视频 CLI 参数，在已授权的本机实例运行原生预生产、逐镜资格、生成和后期。沿同一项目及 job ID，核对媒体、技术质检、交付清单和原始回执。MCP 可用 `pengmanager_video_capabilities` 查看数字员工、技能、工具及依赖。 [原生视频接入](CODEX-VIDEO-QUICKSTART.md)

本地演示使用合成样本。真实生产及发布以本次账户、数据、预算与授权为准。状态未知时先回读现有 job 或回执，再处理重试。
