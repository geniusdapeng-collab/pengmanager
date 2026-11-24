import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPengManagerApplication } from "../src/application.mjs";
import { hashAdminPassword } from "../src/security/admin-auth.mjs";
import { demoEnvironment, demoSeedDirectory } from "./demo.mjs";

const directory = await mkdtemp(join(await realpath(tmpdir()), "pengmanager-smoke-"));
const password = randomBytes(24).toString("base64url");
const nativeFetch = globalThis.fetch;
const checks = {};
let application;

globalThis.fetch = async (value, options) => {
  const url = new URL(value instanceof Request ? value.url : value);
  assert.equal(url.hostname, "127.0.0.1", "The smoke test does not contact external servers");
  assert.equal(url.protocol, "http:");
  return nativeFetch(value, { ...options, redirect: "manual" });
};

try {
  const env = demoEnvironment(directory, { passwordHash: await hashAdminPassword(password) });
  application = await createPengManagerApplication({
    env,
    seedDirectory: demoSeedDirectory,
    finalContentBackup: null,
    logger: { log() {} },
  });
  const { port } = await application.listen({ port: 0 });
  assert.equal(await application.videoStart, false, "Native video must stay stopped");
  const origin = `http://127.0.0.1:${port}`;

  async function check(label, path, status, options) {
    const response = await fetch(origin + path, options);
    assert.equal(response.status, status, `${label} returned an unexpected status`);
    checks[label] = status;
    return response;
  }

  const health = await check("health", "/healthz", 200);
  assert.equal((await health.json()).ok, true);
  for (const language of ["zh", "en"]) {
    const response = await check(`website_${language}`, `/${language}`, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(await response.text(), /<html(?:\s|>)/i);
  }
  const adminRedirect = await check("admin_requires_login", "/admin", 302);
  assert.equal(adminRedirect.headers.get("location"), "/login");
  await check("anonymous_api_rejected", "/api/summary", 401);
  const bodyHeaders = { "Content-Type": "application/json", Origin: origin };
  await check("wrong_password_rejected", "/api/auth/login", 401, {
    method: "POST", headers: bodyHeaders, body: JSON.stringify({ password: "not-the-demo-password" }),
  });
  const login = await check("administrator_login", "/api/auth/login", 200, {
    method: "POST", headers: bodyHeaders, body: JSON.stringify({ password }),
  });
  const setCookie = login.headers.get("set-cookie");
  assert.match(setCookie ?? "", /HttpOnly/i);
  const cookie = setCookie.split(";", 1)[0];
  const headers = { Cookie: cookie };
  const admin = await check("administrator_page", "/admin", 200, { headers });
  assert.match(await admin.text(), /<html(?:\s|>)/i);
  const bootstrap = await check("administrator_bootstrap", "/api/bootstrap", 200, { headers });
  const bootstrapped = await bootstrap.json();
  assert.equal(bootstrapped.accounts.length, 1);
  assert.equal(bootstrapped.accounts[0].id, "demo-github");
  const editorial = await check("editorial_bootstrap", "/api/editorial/bootstrap", 200, { headers });
  assert.ok(typeof await editorial.json() === "object");
  const geo = await check("geo_summary", "/api/geo/engine/summary", 200, { headers });
  assert.ok(typeof (await geo.json()).metrics === "object");
  assert.ok((await stat(env.DATA_FILE)).isFile());
  assert.ok((await stat(env.GEO_ENGINE_DB)).isFile());
  await check("administrator_logout", "/api/auth/logout", 200, {
    method: "POST", headers: { ...bodyHeaders, Cookie: cookie },
  });
  await check("expired_session_rejected", "/api/summary", 401, { headers });
  console.log(JSON.stringify({ checks, nativeVideoStarted: false, externalRequests: false }, null, 2));
} finally {
  globalThis.fetch = nativeFetch;
  try { await application?.stop(); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
