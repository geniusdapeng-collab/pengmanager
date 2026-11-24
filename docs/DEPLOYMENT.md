# Local deployment

Use `pnpm demo` for a temporary loopback instance. For a persistent local instance, set `DATA_FILE` to your chosen state path using [.env.example](../.env.example) and run `node --env-file=.env src/server.mjs`. Use an owner-only data directory and keep credentials out of Git.

The server requires a matching HTTPS `PUBLIC_ORIGIN`, `ALLOWED_HOSTS` and a valid `ADMIN_PASSWORD_HASH` for production or non-loopback use. Create a password hash locally with `node src/security/admin-auth.mjs hash-password`. Supply any model or publishing credentials only in the process that needs them and configure the destination explicitly.

Set `PUBLIC_WEBSITE=1` to serve the public site. This setting displays approved published versions. GEO stores observations in SQLite under the local runtime profile. `ENABLE_MEDIA_RENDER=false` skips launching the optional native video engine. See [video integration](CODEX-VIDEO-QUICKSTART.md) for the additional setup boundary.
