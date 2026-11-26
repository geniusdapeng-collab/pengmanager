# 鹏经理Codex版 repository instructions

Read [the Agent guide](docs/AI-AGENT-GUIDE.md) before running a scoped Agent task. Keep development tests and demonstrations local. Use fictional inputs for fixtures. Runtime credentials, approval data, real account records, private media and production receipts belong in local deployment storage.

Use the existing application and connector entry points. Preserve the boundaries for approvals, actor scope, audit events, idempotency and verified publication receipts. Keep the user's supplied text and authorized assets exact. Model calls, external publication and video generation require explicit authorization for the intended account and operation.

Use `node scripts/agent.mjs list` or MCP `tools/list` to discover the registered capabilities. For articles and graphics, plan with `pengmanager_editorial_plan` and use the configured local Content Director and the original job ID. With an authorized content worker, run its existing scoped CLI. For video, use the native workflow and preflight, then the standard video CLI. Keep review, publication, and receipt verification in the application workflow.

Verify changes with `pnpm check`, `pnpm test`, `pnpm test:engines`, and `pnpm smoke`. Report the test scope and any unavailable dependencies.
