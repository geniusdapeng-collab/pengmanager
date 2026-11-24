# Connect an AI workbench

Use Node.js 24 and install the checkout's dependencies. Start by running `pnpm agent:guide`. A shell client can inspect `node scripts/agent.mjs list` and `node scripts/agent.mjs describe <id>`.

To generate a client configuration, use `node scripts/ai-workbench.mjs config --client codex` or `node scripts/ai-workbench.mjs config --client qoder`. Merge the named server entry in your client. The config command prints a proposal. Start the MCP server with `node scripts/agent-mcp.mjs` and read the generated guide before invoking a capability.

Use explicit process-scoped configuration for authorized credentials. The optional video runtime and its checkout-specific readiness checks are described in [video integration](CODEX-VIDEO-QUICKSTART.md).
