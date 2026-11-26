import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createPengManagerAgent } from '../src/agent.mjs';
import { parseAgentArgs } from '../scripts/agent.mjs';

const root = path.resolve(import.meta.dirname, '..');
async function fixture(t, { fetchImplementation, env = {} } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pengmanager-agent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const runtime = { async start() { calls.push('start'); }, async nativeSession() { calls.push('session'); return { token: 'test-only-session' }; }, async stop() { calls.push('stop'); }, async status() { return { state: 'stopped', ready: false, workbenchEnabled: false }; } };
  const agent = await createPengManagerAgent({ rootDir: root, dataDir: directory, env, runtimeFactory: () => runtime, fetchImplementation });
  return { agent, calls, directory, runtime };
}
test('PengManager CLI and MCP expose the complete reviewed catalog and local inventory without starting services', async t => {
  const { agent, calls, runtime } = await fixture(t);
  const actual = JSON.parse(await readFile(path.join(root, 'engines/video-edit/pengmanager-capabilities.json'), 'utf8'));
  const pin = JSON.parse(await readFile(path.join(root, 'upstreams/workloom-video-edit.pin.json'), 'utf8'));
  assert.equal(actual.source.pin, pin.commit);
  assert.equal(actual.source.tree, pin.tree);
  runtime.capabilities = async () => ({ schemaVersion: actual.schemaVersion, scope: 'complete-edit', sourceMain: pin.commit, state: 'stopped', ready: false, catalog: actual, inventory: {} });
  assert.equal(agent.list().productId, 'pengmanager-system');
  assert.ok(agent.list().capabilities.some(item => item.id === 'growth.video.production.shots'));
  assert.ok(agent.tools().some(item => item.name === 'pengmanager_core_agents_list'));
  assert.equal(new Set(agent.tools().map(item => item.name)).size, agent.tools().length);
  const result = await agent.invoke('pengmanager.video.capabilities');
  assert.deepEqual(result.catalog.roles.map(item => item.id), actual.roles.map(item => item.id));
  assert.deepEqual(result.catalog.skills.map(item => item.id), actual.skills.map(item => item.id));
  assert.deepEqual(result.catalog.tools.map(item => item.id), actual.tools.map(item => item.id));
  assert.deepEqual(calls, []);
});
test('embedded 30-second production preview never offers a direct paid command and reads only current process credential presence', async t => {
  for (const env of [
    { VOLCENGINE_ARK_API_KEY: '', ARK_API_KEY: 'test-only-ark-alias' },
    { VOLCENGINE_ARK_API_KEY: '', ARK_API_KEY: '' },
  ]) {
    const { agent, calls, directory } = await fixture(t, { env });
    await mkdir(path.join(directory, 'film'), { mode: 0o700 });
    await writeFile(path.join(directory, 'film/route.json'), JSON.stringify({ decision: { route: 'marketing' } }));
    await writeFile(path.join(directory, 'film/shots.json'), JSON.stringify({ shots:
      Array.from({ length: 6 }, (_, index) => ({ shotId: `S${index + 1}`, durationSec: 5 })),
    }));
    const id = 'growth.video.production.plan';
    const result = (await agent.invoke(id, { projectId: 'RC-30', routePath: 'film/route.json', shotlistPath: 'film/shots.json' })).result;
    assert.equal(result.previewOnly, true);
    assert.equal(result.ready, false);
    assert.equal(result.execution, null);
    assert.equal(result.recommendedCommand, null);
    assert.equal(result.recommendedPowerShellCommand, null);
    assert.ok(result.beforeRun.some(step => step.includes('工作台')));
    assert.equal(result.checklist.find(check => check.id === 'ark-key').ok, Boolean(env.ARK_API_KEY));
    assert.equal(result.checklist.find(check => check.id === 'route').ok, true);
    assert.equal(result.checklist.find(check => check.id === 'shotlist').ok, true);
    assert.ok(agent.describe(id).description.includes('原生工作台'));
    assert.ok(agent.tools().find(tool => tool.name === 'pengmanager_growth_video_production_plan').description.includes('原生工作台'));
    assert.ok(!JSON.stringify(result).includes('test-only-ark-alias'));
    assert.ok(!(await readFile(path.join(directory, 'process-model-keys-only.env'), 'utf8')).includes('test-only-ark-alias'));
    assert.deepEqual(calls, []);
  }
});
test('native capability passes through the fixed backend with an actual runtime-issued session seam and no loginAs fallback', async t => {
  const transport = [];
  const { agent, calls } = await fixture(t, { fetchImplementation: async (url, options) => { transport.push({ url: String(url), options }); return new Response(JSON.stringify({ result: { data: { fixture: true } } })); } });
  const result = await agent.invoke('core.workspace.profile');
  assert.deepEqual(result.result, { fixture: true });
  assert.deepEqual(calls, ['start', 'session']);
  assert.equal(transport.length, 1);
  assert.equal(transport[0].url, 'http://127.0.0.1:18797/trpc/workspace.profile');
  assert.equal(transport[0].options.headers.authorization, 'Bearer test-only-session');
  assert.equal(transport[0].options.redirect, 'error');
  await agent.stop(); assert.deepEqual(calls, ['start', 'session', 'stop']);
});
test('agent preflight keeps a missing install passive and starts only the explicitly requested prepared native runtime', async t => {
  const { agent, calls, runtime } = await fixture(t);
  let initialized = false;
  runtime.doctor = async () => ({
    ok: true, workspaceInitialized: initialized, checks: [{ key: 'complete-engine', ok: true }],
    textModel: { configured: true, missing: [] },
  });
  runtime.start = async () => { calls.push('start'); };
  runtime.status = async () => calls.includes('start')
    ? { state: 'ready', ready: true, workbenchEnabled: false, backendHealth: { ok: true }, dbHealth: { ok: true, owned: true } }
    : { state: 'stopped', ready: false, workbenchEnabled: false };
  runtime.capabilities = async () => ({
    modelReadiness: { source: 'current-authenticated-native-rpc', text: { configured: true, currentProcessProbeVerified: false } },
  });
  const id = 'pengmanager.video.preflight';
  assert.equal((await agent.invoke(id, { startNative: true })).startup, 'setup-required');
  initialized = true;
  assert.equal((await agent.invoke(id)).startup, 'not-requested');
  await assert.rejects(agent.invoke(id, { startNative: 'true' }), { code: 'INVALID_INPUT' });
  assert.deepEqual(calls, []);
  const report = await agent.invoke(id, { startNative: true });
  assert.equal(report.startup, 'managed-native');
  assert.equal(report.status.ready, true);
  assert.equal(report.modelReadiness.text.currentProcessProbeVerified, false);
  assert.equal(report.providerCallsPerformed, false);
  assert.equal(report.productionVerified, false);
  assert.equal(agent.tools().find(tool => tool.name === 'pengmanager_video_preflight').annotations.readOnlyHint, false);
  runtime.stop = async () => { calls.push('stop'); runtime.status = async () => ({ state: 'stopped', workbenchEnabled: false }); };
  const stopped = await agent.invoke('pengmanager.video.stop');
  assert.equal(stopped.stoppedByThisProcess, true);
  assert.equal(stopped.status.state, 'stopped');
  assert.equal((await agent.invoke('pengmanager.video.stop')).stoppedByThisProcess, false);
  await agent.stop();
  assert.deepEqual(calls, ['start', 'stop']);
});
test('existing process-only native session attaches without starting or stopping another supervisor', async t => {
  const { agent, calls } = await fixture(t, { env: { WORKLOOM_ACCESS_TOKEN: 'test-only-existing' }, fetchImplementation: async (_url, options) => {
    assert.equal(options.headers.authorization, 'Bearer test-only-existing');
    return new Response(JSON.stringify({ result: { data: [] } }));
  } });
  await agent.invoke('core.agents.list');
  assert.equal((await agent.invoke('pengmanager.video.stop')).stoppedByThisProcess, false);
  await agent.stop(); assert.deepEqual(calls, []);
});
test('native unauthorized response remains a failure and hides the session credential', async t => {
  const { agent } = await fixture(t, { fetchImplementation: async () => new Response(JSON.stringify({ error: { message: 'denied test-only-session', data: { httpStatus: 401, code: 'UNAUTHORIZED' } } }), { status: 401 }) });
  await assert.rejects(agent.invoke('core.workspace.profile'), error => agent.error(error).code === 'UNAUTHORIZED' && !agent.error(error).message.includes('test-only-session'));
  await agent.stop();
});
test('unknown routes, wrong arguments and disabled execution reject before acquiring a native session', async t => {
  const { agent, calls } = await fixture(t);
  await assert.rejects(agent.invoke('auth.desktopLogin'), { code: 'NOT_FOUND' });
  await assert.rejects(agent.invoke('core.workspace.profile', { path: 'auth.desktopLogin' }), { code: 'INVALID_INPUT' });
  await assert.rejects(agent.invoke('pengmanager.video.status', { token: 'fixture' }), { code: 'INVALID_INPUT' });
  const disabled = agent.list().capabilities.find(item => item.enabled === false);
  assert.ok(disabled); await assert.rejects(agent.invoke(disabled.id, { kind: 'consult', title: 'fixture', idempotencyKey: 'fixture-only' }), { code: 'DISABLED' });
  assert.deepEqual(calls, []);
});

test('editorial planning is offline and dispatch sends only the exact job version and idempotency key', async t => {
  const requests = [];
  const { agent, calls } = await fixture(t, { env: { PENGMANAGER_EDITORIAL_ORIGIN: 'http://127.0.0.1:4418' },
    fetchImplementation: async (url, options) => {
      requests.push({ url: String(url), ...options });
      return new Response(JSON.stringify({ id: 'CDJ-fixture', status: 'queued' }), { status: options.method === 'POST' ? 202 : 200 });
    },
  });
  assert.equal(agent.list().productName, '鹏经理Codex版');
  const intent = ' 写一篇编辑流程说明，并画一张配图 ';
  const plan = await agent.invoke('pengmanager.editorial.plan', { brief: { intent } });
  assert.equal(plan.originalIntent, intent);
  assert.equal(plan.artifactKind, 'article_visual');
  assert.equal(plan.providerCallsPerformed, false);
  assert.equal(agent.tools().find(item => item.name === 'pengmanager_editorial_plan').annotations.readOnlyHint, true);
  assert.equal(agent.tools().find(item => item.name === 'pengmanager_editorial_job_dispatch').annotations.readOnlyHint, false);
  assert.deepEqual(requests, []);
  const jobId = 'CDJ-fixture';
  const ifMatch = '"' + 'b'.repeat(64) + '"';
  const dispatch = { jobId, ifMatch, idempotencyKey: 'fixture-dispatch', confirmProduction: true };
  for (const input of [{ ...dispatch, confirmProduction: false }, { ...dispatch, ifMatch: '*' }, { ...dispatch, jobId: '../publish' }, { ...dispatch, url: 'https://example.com' }]) {
    await assert.rejects(agent.invoke('pengmanager.editorial.job.dispatch', input), { code: 'INVALID_INPUT' });
  }
  const brief = { intent, explicitKind: 'article_visual' };
  await agent.invoke('pengmanager.editorial.job.create', { brief, idempotencyKey: 'fixture-creation' });
  await agent.invoke('pengmanager.editorial.job.get', { jobId });
  await agent.invoke('pengmanager.editorial.job.dispatch', dispatch);
  assert.deepEqual(requests.map(row => [row.method, row.url]), [
    ['POST', 'http://127.0.0.1:4418/api/content-director/jobs/agent-draft'],
    ['GET', 'http://127.0.0.1:4418/api/content-director/jobs/CDJ-fixture'],
    ['POST', 'http://127.0.0.1:4418/api/content-director/jobs/CDJ-fixture/agent-dispatch'],
  ]);
  assert.deepEqual(JSON.parse(requests[0].body), brief);
  assert.equal(requests[2].headers['If-Match'], ifMatch);
  assert.equal(requests[2].headers['Idempotency-Key'], 'fixture-dispatch');
  assert.deepEqual(JSON.parse(requests[2].body), { confirmProduction: true });
  assert.ok(requests.every(row => row.redirect === 'error' && !('Authorization' in row.headers) && !('Cookie' in row.headers)));
  assert.deepEqual(calls, []);
});

test('editorial connection is opt-in, rejects nonloopback hosts, and hides network errors', async t => {
  for (const [origin, code] of [[undefined, 'EDITORIAL_ORIGIN_REQUIRED'], ['http://localhost:4318', 'EDITORIAL_ORIGIN_INVALID'],
    ['https://example.com', 'EDITORIAL_ORIGIN_INVALID'], ['http://127.0.0.1:4318/admin', 'EDITORIAL_ORIGIN_INVALID'],
    ['http://127.0.0.1:99999', 'EDITORIAL_ORIGIN_INVALID']]) {
    const { agent } = await fixture(t, { env: { PENGMANAGER_EDITORIAL_ORIGIN: origin }, fetchImplementation: () => assert.fail('unexpected request') });
    await assert.rejects(agent.invoke('pengmanager.editorial.status'), { code });
  }
  const { agent } = await fixture(t, { env: { PENGMANAGER_EDITORIAL_ORIGIN: 'http://[::1]:4318' }, fetchImplementation: () => { throw new Error('secret fixture transport'); } });
  await assert.rejects(agent.invoke('pengmanager.editorial.status'), error => error.code === 'EDITORIAL_READBACK_REQUIRED' && !error.message.includes('secret fixture transport'));
});
test('CLI argument validation keeps capability and input-file boundaries', () => {
  assert.equal(parseAgentArgs(['invoke', 'core.workspace.profile', '--input-file', '-']).inputFile, '-');
  for (const args of [[], ['invoke'], ['unknown'], ['list', '--input-file', 'data'], ['status', '--base-url', 'https://example.com'], ['invoke', 'id', '--data-dir', '/tmp/a', '--data-dir', '/tmp/b']]) assert.throws(() => parseAgentArgs(args), { code: 'USAGE' });
});
function child(script, args = [], input = '') {
  return new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, [script, ...args], { cwd: root, env: { ...process.env, WORKLOOM_ACCESS_TOKEN: '', WORKLOOM_C_TOKEN: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    processChild.stdout.on('data', value => { stdout += value; }); processChild.stderr.on('data', value => { stderr += value; });
    processChild.on('error', reject); processChild.on('close', code => resolve({ code, stdout, stderr })); processChild.stdin.end(input);
  });
}
test('actual CLI lists PengManager capabilities and reads stopped status without a service or provider call', async () => {
  for (const command of ['list', 'status']) {
    const result = await child('scripts/agent.mjs', [command]);
    assert.equal(result.code, 0, result.stderr); const value = JSON.parse(result.stdout);
    if (command === 'list') assert.equal(value.productId, 'pengmanager-system');
    else assert.equal(value.ready, false);
  }
  const intent = '写一篇发布流程说明并配架构图';
  const plan = await child('scripts/agent.mjs', ['invoke', 'pengmanager.editorial.plan', '--input-file', '-'], JSON.stringify({ brief: { intent } }));
  assert.equal(plan.code, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).originalIntent, intent);
});
test('actual MCP stdio initialize, list and call use valid JSON-RPC and preserve tool failures', async () => {
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pengmanager_video_status', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'unregistered', arguments: {} } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'pengmanager_editorial_plan', arguments: { brief: { intent: '做一张流程图' } } } },
  ];
  const result = await child('scripts/agent-mcp.mjs', [], requests.map(item => JSON.stringify(item)).join('\n') + '\n');
  assert.equal(result.code, 0, result.stderr); const messages = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(messages.map(item => item.id), [1, 2, 3, 4, 5]);
  assert.equal(messages[0].result.serverInfo.name, 'pengmanager-system');
  assert.equal(messages[0].result.serverInfo.title, '鹏经理Codex版');
  assert.match(messages[0].result.instructions, /pengmanager_video_preflight/);
  assert.ok(messages[1].result.tools.some(item => item.name === 'pengmanager_core_workspace_profile'));
  assert.ok(messages[1].result.tools.some(item => item.name === 'pengmanager_editorial_job_dispatch'));
  assert.equal(messages[2].result.isError, false); assert.equal(JSON.parse(messages[2].result.content[0].text).ready, false);
  assert.equal(messages[3].result.isError, true); assert.equal(JSON.parse(messages[3].result.content[0].text).error.code, 'NOT_FOUND');
  assert.equal(messages[4].result.isError, false);
  assert.equal(JSON.parse(messages[4].result.content[0].text).artifactKind, 'pure_visual');
});
