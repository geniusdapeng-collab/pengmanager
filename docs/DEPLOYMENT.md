# Local deployment

Use `pnpm demo` for a temporary loopback instance. For a persistent local instance, set `DATA_FILE` to an owner-only state path using [.env.example](../.env.example), then run `node --env-file=/absolute/private/pengmanager-codex.env src/server.mjs`. Give each edition its own data directories and listener ports when running on the same computer.

The server requires a matching HTTPS `PUBLIC_ORIGIN`, `ALLOWED_HOSTS` and a valid `ADMIN_PASSWORD_HASH` for production or non-loopback use. Create a password hash locally with `node src/security/admin-auth.mjs hash-password`. Provide `OPENAI_API_KEY` in the application, approved content worker, or review worker process that needs it. Select `gpt-6.2-sol` (default) or `gpt-6.2-astra` with `PENGMANAGER_CODEX_MODEL`. Codex client sign-in is for the client itself. Configure publishing accounts and media vendors independently. [OpenAI model guide](https://developers.openai.com/api/docs/guides/latest-model)

Set `PUBLIC_WEBSITE=1` to serve the public site. This setting displays approved published versions. GEO stores observations in SQLite under the local runtime profile. `ENABLE_MEDIA_RENDER=false` skips launching the optional native video engine. See [video integration](CODEX-VIDEO-QUICKSTART.md) for the additional setup boundary.
