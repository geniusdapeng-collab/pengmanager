import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { GeoStore } from "../lib/store.mjs";
import { GeoEvidenceService } from "../lib/service.mjs";
import { createGeoStudioServer } from "../server.mjs";
import { codexTextRegistration } from "../../../src/model-routing/codex.mjs";

async function fixtureRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "geo-evidence-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("100-query fixture run reaches evidence, negative incident and publication", async (t) => {
  const root = await fixtureRoot(t);
  const dbPath = join(root, "studio.sqlite");
  const store = new GeoStore(dbPath);
  t.after(() => {
    try { store.close(); } catch {}
  });
  const service = new GeoEvidenceService(store, { rootDir: root });

  const run = await service.runObservations({
    provider: "fixture",
    limit: 100,
    concurrency: 4,
  });
  assert.equal(run.status, "completed");
  assert.equal(run.planned, 100);
  assert.equal(run.successful, 100);
  assert.equal(run.failed, 0);
  assert.ok(run.metrics.evidenceCoverageRate > 0);
  assert.ok(run.metrics.brandNegativeSamples > 0);

  const reanalyzed = service.reanalyzeRun(run.runId);
  assert.equal(reanalyzed.updated, 100);
  assert.equal(reanalyzed.brandNegativeSamples, run.metrics.brandNegativeSamples);

  const summary = service.summary();
  assert.ok(summary.incidents.length > 0);

  const articles = service.generateArticles();
  assert.equal(articles.created.length, 10);
  const regenerated = service.generateArticles({ topicIds: ["agent-product-system"], force: true });
  assert.equal(regenerated.created.length, 1);
  assert.notEqual(regenerated.created[0].slug, articles.created.find((article) => article.topic_id === "agent-product-system").slug);
  const publication = await service.publishArticle({
    articleId: articles.created[0].id,
    channel: "local",
    approvedBy: "test-qa",
  });
  assert.equal(publication.status, "published");
  assert.match(publication.url, /^file:\/\//);
  assert.match(publication.contentSha256, /^[a-f0-9]{64}$/);

  const report = await service.writeReport({ runId: run.runId });
  assert.match(report.markdownPath, /REPORT\.md$/);
});

test("HTTP API serves health, summary and fixtures securely on loopback", async (t) => {
  const root = await fixtureRoot(t);
  const localSecret = randomUUID();
  const app = createGeoStudioServer({
    rootDir: root,
    dbPath: join(root, "server.sqlite"),
    token: localSecret,
  });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;

  const unauthorized = await fetch(`${base}/api/health`);
  assert.equal(unauthorized.status, 401);

  const health = await fetch(`${base}/api/health`, {
    headers: { authorization: `Bearer ${localSecret}` },
  });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const runResponse = await fetch(`${base}/api/run`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${localSecret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ provider: "fixture", limit: 10, concurrency: 2 }),
  });
  assert.equal(runResponse.status, 200);
  const run = await runResponse.json();
  assert.equal(run.successful, 10);
  const locked = await fetch(`${base}/api/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${localSecret}`, "content-type": "application/json" },
    body: JSON.stringify({ provider: "codex-search", limit: 1 }),
  });
  assert.equal(locked.status, 403);

  const html = await fetch(`${base}/`);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /GeoEvidence Studio/);
});

test("Codex GEO records only provider search sources and preserves that evidence on reanalysis", async t => {
  const root = await fixtureRoot(t);
  const store = new GeoStore(join(root, "codex.sqlite"));
  t.after(() => store.close());
  const env = { OPENAI_API_KEY: "isolated-test-key" };
  const model = codexTextRegistration({ env }).officialModelId;
  let searchCompleted = true;
  const requests = [];
  const service = new GeoEvidenceService(store, { rootDir: root, env, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (String(url).endsWith("/input_tokens")) {
      return Response.json({ object: "response.input_tokens", input_tokens: 60 });
    }
    return Response.json({
      id: "resp_geo_fixture", model, status: "completed",
      output: [
        ...(searchCompleted ? [{ type: "web_search_call", status: "completed",
          action: { sources: [{ url: "https://publisher.example/evidence" }, { url: "https://source-only.example/uncited" }] } }] : []),
        { type: "message", role: "assistant", status: "completed", content: [
          { type: "output_text", text: "带有模型文本链接的回答 [未验证链接](https://model-asserted.example/example)。",
            annotations: [{ type: "url_citation", title: "实际来源", url: "https://publisher.example/evidence" }] },
        ] },
      ],
      usage: { input_tokens: 60, output_tokens: 30, total_tokens: 90 },
    });
  } });
  assert.equal(service.health().providers["codex-search"], true);
  await assert.rejects(service.runObservations({ provider: "codex-search", platform: "another-provider", limit: 1 }));
  assert.equal(requests.length, 0);
  const run = await service.runObservations({ provider: "codex-search", limit: 1 });
  assert.equal(run.successful, 1);
  assert.deepEqual(requests[1].tools, [{ type: "web_search" }]);
  const getSample = () => store.listSamples({ runId: run.runId, limit: 1 })[0];
  assert.equal(getSample().raw.modelReceipt.responseId, "resp_geo_fixture");
  assert.ok(getSample().raw.sources.some(row => row.url === "https://source-only.example/uncited"));
  assert.deepEqual(getSample().citations.map(row => row.url), ["https://publisher.example/evidence"]);
  service.reanalyzeRun(run.runId);
  assert.deepEqual(getSample().citations.map(row => row.url), ["https://publisher.example/evidence"]);
  searchCompleted = false;
  const failed = await service.runObservations({ provider: "codex-search", limit: 1 });
  assert.equal(failed.failed, 1);
  assert.equal(failed.successful, 0);
});

test("in-process GEO tool bridge exposes declared tools with receipts", async (t) => {
  const root = await fixtureRoot(t);
  const app = createGeoStudioServer({
    rootDir: root,
    dbPath: join(root, "bridge.sqlite"),
  });
  t.after(() => app.store.close());
  const query = app.store.listQueries({ category: "brand", limit: 1 })[0];
  const collected = await app.service.handleTool("visibility.collect", {
    provider: "fixture",
    limit: 1,
    queryId: query.id,
  }, { tenantId: "tenant-test", workspaceId: "workspace-test" });
  assert.equal(collected.receipt.synced, true);
  assert.equal(collected.receipt.mode, "simulated");

  const generated = await app.service.handleTool(
    "geo.rewrite",
    { dataMode: "draft" },
    { tenantId: "tenant-test", workspaceId: "workspace-test" },
  );
  assert.equal(generated.receipt.synced, true);
  const articleId = app.store.listArticles(1)[0].id;
  const published = await app.service.handleTool(
    "rpa.source_publish",
    {
      articleId,
      channel: "local",
      approvedBy: "bridge-test",
    },
    { tenantId: "tenant-test", workspaceId: "workspace-test" },
  );
  assert.equal(published.receipt.synced, true);
  assert.equal(published.result.status, "published");
});
