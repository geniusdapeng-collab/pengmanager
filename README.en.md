# PengManager Codex Edition · 鹏经理Codex版

PengManager Codex Edition is a local-first workspace for bilingual editorial production, native video workflows, and generative engine optimization (GEO). Use Codex through the CLI or MCP to discover digital employees, plan work, and track the original job through review and delivery. The system uses OpenAI Responses for text generation and review, with `gpt-6.2-sol` as the default model.

[中文文档](README.md) · [Architecture](README.md#架构) · [Agent guide](docs/AI-AGENT-GUIDE.md)

## Start a local demo

Use Node.js 24 and pnpm 11.25.0.

```bash
git clone https://github.com/geniusdapeng-collab/pengmanager-codex.git
cd pengmanager-codex
pnpm install --frozen-lockfile
pnpm demo
```

Open the [operator console](http://127.0.0.1:4318/admin) or the [English site](http://127.0.0.1:4318/en). The demo uses fictional fixtures, a temporary data directory, and a loopback listener. Press Ctrl+C to stop it.

## Connect Codex

Run `pnpm agent:guide` and `node scripts/agent.mjs list` from the checkout, or export a Codex MCP entry with `pnpm agent:config --client codex` and call `pengmanager_agent_guide`. The guide describes editorial planning and job tracking, the paired content employee worker, and the standard video CLI. [Agent guide](docs/AI-AGENT-GUIDE.md)

Codex uses its own sign-in. Application and worker processes use `OPENAI_API_KEY` for actual model requests. `PENGMANAGER_CODEX_MODEL` selects `gpt-6.2-sol` or `gpt-6.2-astra`. Native video also requires local tools, configured media providers, and licensed assets. [Deployment](docs/DEPLOYMENT.md) · [Video integration](docs/CODEX-VIDEO-QUICKSTART.md) · [OpenAI model guide](https://developers.openai.com/api/docs/guides/latest-model)

Run `pnpm check`, `pnpm test`, `pnpm test:engines`, and `pnpm smoke` to verify the public checkout locally.

PengManager-owned code is available under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for upstream attributions and third-party terms.
