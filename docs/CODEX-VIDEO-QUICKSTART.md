# 鹏经理Codex版原生视频接入

鹏经理包含原生 Edit 引擎、PostgreSQL 启动编排、模型路由、审批、分镜及渲染服务、剪辑与口播工具，还有正式后期和技术质检。源码位于 [engines/video-edit](../engines/video-edit/) 和 [src/video-runtime](../src/video-runtime/)。

用 `PENGMANAGER_VIDEO_DATA_DIR` 指定本版独立的实例目录，安装 Node.js 与项目锁定的依赖。实际生成文本方案、分镜和审核判断需要本机执行进程配置 `OPENAI_API_KEY`，模型从 `PENGMANAGER_CODEX_MODEL` 读取。视频、语音和后期继续走原生工具与已授权的媒体供应商。按流程检查本机环境。

```bash
pnpm video:doctor
pnpm video:setup
pnpm video:start
```

`video:setup` 安装或验证本机工具、数据库和内嵌工作台。原生作业使用自己有权限的供应商和素材。公开快照逐文件核验已提供的引擎资源。受限的第三方曲目、产品素材、Live2D 等资源可根据各自条款单独配置。 [许可和出处](../NOTICE)

`pnpm demo` 是无需供应商的本机体验。要对正式视频任务做预检、归档、续办和成片回读，按[原生工作流](PENGMANAGER-VIDEO-MAKE.md)和[Agent 指引](AI-AGENT-GUIDE.md)使用当前项目的原始任务 ID。
