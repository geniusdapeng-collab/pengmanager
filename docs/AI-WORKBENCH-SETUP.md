# Connect Codex to PengManager

Use Node.js 24 and install the checkout's dependencies. Start by running `pnpm agent:guide`. A shell client can inspect `node scripts/agent.mjs list` and `node scripts/agent.mjs describe <id>`.

Generate the Codex MCP entry with `pnpm agent:config --client codex --data-dir /absolute/private/pengmanager-codex-video`. Add the `pengmanager-video` entry to your Codex MCP configuration, refresh the client and call `pengmanager_agent_guide`. The exporter prints a proposal. `pnpm agent:config --client qoder` and `--client generic` provide equivalent stdio settings for other MCP clients. [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

Use `PENGMANAGER_EDITORIAL_ORIGIN=http://127.0.0.1:4318` when starting the CLI or exporting the MCP configuration to opt into the matching local editorial server. The exporter carries this loopback address and public runtime coordinates. A specified `--model-env-file /absolute/private/pengmanager-codex.env` is passed as a path. Keep model, media and publishing credentials in the authorized processes. The app and workers read `OPENAI_API_KEY` for internal text and review calls. [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) · [Deployment](DEPLOYMENT.md)
