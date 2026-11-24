# 原生视频运行与 Agent 接入

鹏经理包含原生 Edit 引擎、PostgreSQL 启动编排、模型路由、审批、分镜及渲染服务、剪辑与口播工具，还有正式后期和技术质检。源码位于 [engines/video-edit](../engines/video-edit/) 和 [src/video-runtime](../src/video-runtime/)。

用独立的实例目录配置运行数据和工具，安装 Node.js 与项目锁定的依赖。按流程检查本机环境。

```bash
pnpm video:doctor
pnpm video:setup
pnpm video:start
```

`video:setup` 安装或验证本机工具、数据库和内嵌工作台。原生作业使用自己有权限的供应商和素材。公开快照逐文件核验已提供的引擎资源。受限的第三方曲目、产品素材、Live2D 等资源可根据各自条款单独配置。 [许可和出处](../NOTICE)

`pnpm demo` 是无需供应商的本机体验。要对正式视频任务做预检、归档、续办和成片回读，按[原生工作流](PENGMANAGER-VIDEO-MAKE.md)和[Agent 指引](AI-AGENT-GUIDE.md)使用当前项目的原始任务 ID。
