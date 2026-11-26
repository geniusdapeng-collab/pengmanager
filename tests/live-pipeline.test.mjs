import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { JsonStore } from "../src/storage/json-store.mjs";
import { loadSeedState } from "../src/services/bootstrap.mjs";
import { GeoOsService } from "../src/services/geo-os-service.mjs";
import { LivePipelineService } from "../src/services/live-pipeline.mjs";
import { createGeoOsServer } from "../src/http/server.mjs";
import { codexTextRegistration } from "../src/model-routing/codex.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const dataDir = join(rootDir, "data", "seed");
const now = () => new Date("2026-10-18T12:30:00.000Z");

test("legacy GitHub entry rejects editorial and unknown snapshots before any outbound platform call", async () => {
  for (const marker of [{ snapshotSchema: 2 }, { snapshotSchema: "editorial-v2" }, { snapshotSchema: 999 },
    { snapshotSchema: null }, { snapshotSchema: undefined }, { editionId: "ED-00001" }, { destinationId: "DST-00001" }]) {
    let outboundCalls = 0, receiptCalls = 0;
    const live = new LivePipelineService({
      service: { store: { snapshot() { return { content: [{ id: "CNT-V2", status: "scheduled", ...marker }], accounts: [], claims: [] }; } },
        async recordPublication() { receiptCalls += 1; } },
      github: { async createIssue() { outboundCalls += 1; return { url: "https://github.com/owner/repo/issues/1" }; } }, clock: now,
    });
    await assert.rejects(live.publishContentToGitHub({ contentId: "CNT-V2" }), error => error.code === "EDITORIAL_OPERATION_REQUIRED");
    assert.equal(outboundCalls, 0); assert.equal(receiptCalls, 0); assert.equal(live.publishingContentIds.size, 0);
  }
});

test("current-model content can pass the evidence state machine and receive a platform receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pengstack-live-"));
  const filePath = join(directory, "state.json");

  try {
    const store = new JsonStore({ filePath, clock: now });
    await store.open(() => loadSeedState(dataDir));
    const service = new GeoOsService({ store, clock: now });
    const claimId = store.snapshot().claims[0].id;
    const accountId = store.snapshot().accounts.find((row) => row.platform === "GitHub").id;
    const model = {
      async health() {
        return { ok: true };
      },
      async generateContent() {
        return {
          title: "为什么 GEO 需要证据控制面",
          body: "GEO 不是让模型说好话，而是让正确事实可验证、可引用、可复测。",
          hook: "证据先于内容",
          cta: "查看项目",
          hashtags: ["#GEO"],
          model: codexTextRegistration().officialModelId,
          provider: "openai",
          responseId: "resp-test",
          usage: { total_tokens: 100 },
          responseHash: "a".repeat(64),
        };
      },
    };
    const github = {
      async health() {
        return { ok: true, configured: true };
      },
      async createIssue(input) {
        assert.match(input.body, /可验证/);
        return {
          id: 1,
          number: 1,
          url: "https://github.com/owner/repo/issues/1",
          createdAt: now().toISOString(),
          receiptHash: "b".repeat(64),
        };
      },
    };
    const unused = {
      async health() {
        return { configured: false };
      },
    };
    const live = new LivePipelineService({
      service,
      model,
      github,
      geoEvidence: unused,
      videoEdit: unused,
      clock: now,
    });

    await service.approveClaim(claimId, {
      approvedBy: "Dapeng Li",
      publicLevel: "private",
    });
    await store.mutate({ type: "account.activated", actor: "test" }, (state) => {
      const account = state.accounts.find((item) => item.id === accountId);
      account.status = "active";
      account.policyStatus = "reviewed";
      account.policyCheckedAt = now().toISOString();
      return account;
    });

    const generated = await live.generateContent({
      brief: "解释证据优先的 GEO",
      claimIds: [claimId],
      platform: "GitHub",
    });
    const contentId = generated.content.id;
    assert.equal(generated.content.generation.provider, "openai");
    for (const target of ["fact_check", "approved", "scheduled"]) {
      await service.transitionContent(contentId, {
        target,
        actor: "Dapeng Li",
        approvedBy: "Dapeng Li",
      });
    }
    const published = await live.publishContentToGitHub({ contentId, accountId });
    assert.equal(published.issue.number, 1);
    assert.equal(published.publication.dataMode, "real");
    assert.equal(
      store.snapshot().content.find((item) => item.id === contentId).status,
      "published",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex collection route requires confirmation and the old provider route cannot silently substitute results", async t => {
  let collected = 0;
  const server = createGeoOsServer({ service: {}, publicDir: join(rootDir, "public"), livePipeline: {
    async collectCodex() { collected++; return { provider: "codex-search" }; },
  } });
  await new Promise((ready, failed) => {
    server.once("error", failed);
    server.listen(0, "127.0.0.1", ready);
  });
  t.after(() => new Promise(resolveClose => server.close(resolveClose)));
  const run = (name, confirm) => fetch(`http://127.0.0.1:${server.address().port}/api/live/${name}/collect`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm }),
  });
  assert.equal((await run("codex", false)).status, 400);
  assert.equal((await run("deepseek", true)).status, 410);
  assert.equal(collected, 0);
  const result = await run("codex", true);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).provider, "codex-search");
  assert.equal(collected, 1);
});
