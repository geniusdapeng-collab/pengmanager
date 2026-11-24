import assert from 'node:assert/strict';
import test from 'node:test';
import { createPengManagerAgent } from '../src/agent.mjs';
import { GitHubAdapter } from '../src/adapters/github.mjs';

test('public agent can serve the guide and report the missing optional engine', async () => {
  const agent = await createPengManagerAgent({ env: {}, runtimeFactory: () => assert.fail('unexpected native startup') });
  try {
    assert.equal(agent.list().embeddedProductId, null);
    assert.ok(agent.tools().some(tool => tool.name === 'pengmanager_agent_guide'));
    const guide = await agent.invoke('pengmanager.agent.guide', {});
    assert.equal(guide.documents.length, 5);
    assert.equal((await agent.invoke('pengmanager.video.status', {})).reason, 'VIDEO_RUNTIME_NOT_INSTALLED');
    const preflight = await agent.invoke('pengmanager.video.preflight', { startNative: true });
    assert.equal(preflight.startup, 'setup-required');
    assert.equal(preflight.providerCallsPerformed, false);
    await assert.rejects(agent.invoke('pengmanager.video.preflight', { startNative: 'true' }), { code: 'INVALID_INPUT' });
  } finally {
    await agent.stop();
  }
});

test('an inherited GitHub token grants no access without a selected repository', async () => {
  const adapter = new GitHubAdapter({ token: 'fixture-token', repository: '', fetchImpl: () => assert.fail('unexpected external request') });
  assert.equal(adapter.status().configured, false);
  assert.equal((await adapter.health()).error, 'GITHUB_REPOSITORY not configured');
  await assert.rejects(adapter.createIssue({ title: 'Demo', body: 'Demo body' }), /GITHUB_REPOSITORY/);
});
