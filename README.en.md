# PengManager

PengManager is a local-first workspace for bilingual publishing and generative engine optimization (GEO). It brings editorial drafts, media, approvals, publication receipts, and repeatable evidence collection into a single operator console.

[中文文档](README.md) · [Architecture](README.md#架构) · [Agent guide](docs/AI-AGENT-GUIDE.md)

## Start a local demo

Use Node.js 24 and pnpm 11.25.0.

```bash
git clone https://github.com/geniusdapeng-collab/pengmanager.git
cd pengmanager
pnpm install --frozen-lockfile
pnpm demo
```

Open the [operator console](http://127.0.0.1:4318/admin) or the [English site](http://127.0.0.1:4318/en). The demo uses fictional fixtures, a temporary data directory, and a loopback listener. Press Ctrl+C to stop it.

The host includes the website, editorial and publishing workflow, account operations, model routing, and video integration source. The bundled GeoEvidence engine stores queries, answers, citations, and observations in SQLite. The repository also carries the native video engine source used by the production edition. Running native video requires local tools, provider configuration, and licensed assets for the job. See [deployment](docs/DEPLOYMENT.md) and [video integration](docs/CODEX-VIDEO-QUICKSTART.md).

Run `pnpm check`, `pnpm test`, `pnpm test:engines`, and `pnpm smoke` to verify the public checkout locally.

PengManager-owned code is available under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for upstream attributions and third-party terms.
