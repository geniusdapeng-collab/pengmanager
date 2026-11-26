# Personal GeoEvidence Engine

This directory adapts the production GeoEvidence Studio application at commit
`06b47a15fd114541bd3147dc5c07b944c36bc8da`.

The SQLite schema, providers, answer analysis, incident detection, metrics,
article generation and publication receipts are retained. The default case is
replaced with `pengstack-personal-geo`, and control-plane queries can be
upserted into the same query store.

The upstream customer-facing future-frontdesk constants remain available only
for compatibility tests. Runtime integration uses `personal-case.mjs`.

The Codex edition records real samples through OpenAI Responses. Use
`codex-search` for a sample with an actual web search receipt, or `codex` for a
model answer with search disabled. Citation metrics use URL annotations from
the provider response. Other retrieved sources remain in the evidence receipt.
Existing data keeps its original provider
and model identity.

Use `node engines/geo-evidence/cli.mjs run --provider codex-search --limit 1 --confirm`
with an authorized process-only `OPENAI_API_KEY`. The standalone HTTP API
requires an owner token and `confirm: true` for model observations. The
integrated workbench exposes the same operation as `POST /api/live/codex/collect`,
subject to its normal account scope and confirmation rules. Fixtures and manual
imports retain their own evidence types.
