import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(process.env.DSH_HOST_ANCHOR ?? import.meta.url);
const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')));

const root = fileURLToPath(new URL('../', import.meta.url));
// Exercise identical dispatch contracts against source and the shipped dependency-free bundle.
const source = fileURLToPath(new URL(process.env.DSH_CREW_TEST_BUNDLE === '1'
  ? '../lib/server.mjs' : '../src/server.mjs', import.meta.url));
const loader = new URL('./helpers/fast-mode-loader.mjs', import.meta.url).href;
const registerLoader = `data:text/javascript,${encodeURIComponent(`import { register } from 'node:module'; register(${JSON.stringify(loader)});`)}`;

async function fixture(t, { hubUp = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'crew-fast-mcp-'));
  mkdirSync(join(home, '.config/dsh-crew'), { recursive: true });
  writeFileSync(join(home, '.config/dsh-crew/config.json'), JSON.stringify({ mode: 'auto',
    flash_provider: 'openai-codex', flash_model: 'flash-fixture', pro_provider: 'openai-codex', pro_model: 'pro-fixture' }));
  const seen = { checks: [], jobs: [], probes: [] }; const jobs = new Map();
  const state = { capability: 'supported', failFlash: false, rejectJobs: false };
  const http = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const path = new URL(req.url, 'http://localhost').pathname;
    let result;
    if (path.endsWith('/ping')) result = { ok: true, service: hubUp ? 'dsh-crew-hub' : 'offline-unavailable-hub' };
    else if (path.endsWith('/providers')) result = { ok: true, providers: [{ id: 'openai-codex' }] };
    else if (path.endsWith('/fast-mode/check')) {
      seen.checks.push(body);
      if (state.capability === 'old') { res.statusCode = 404; result = { ok: false, error: 'no route' }; }
      else result = { ok: true, protocol: state.capability === 'wrong_protocol' ? 0 : 1,
        supported: state.capability !== 'unsupported', ...(state.capability === 'unsupported' ? { reason: 'priority_not_supported' } : {}) };
    } else if (path.endsWith('/worker-probe')) { seen.probes.push(body); result = { ok: true, result: { ...body, status: 'verified' } }; }
    else if (path.endsWith('/jobs') && req.method === 'GET') result = { ok: true, jobs: [...jobs.values()] };
    else if (path.endsWith('/jobs') && req.method === 'POST') {
      seen.jobs.push(body);
      if (state.rejectJobs) { res.statusCode = 503; result = { ok: false, error: 'fixture job transport failure' }; }
      else {
        const job = { id: `hub-${seen.jobs.length}`, tier: body.tier, model: body.model, provider: body.provider,
          status: state.failFlash && body.tier === 'flash' ? 'failed' : 'done', error: 'offline scripted failure',
          fast_mode_requested: body.fast_mode, response_service_tier: body.fast_mode ? 'priority' : null };
        jobs.set(job.id, job); result = { ok: true, job };
      }
    } else if (path.includes('/jobs/hub-')) result = { ok: true, job: jobs.get(path.split('/').at(-1)) };
    else { res.statusCode = 404; result = { ok: false, error: 'unknown mock route' }; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', registerLoader, source], cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home, DEEPSEEK_API_KEY: '', DSHPLUGIN_CREW_HUB: `http://127.0.0.1:${http.address().port}` }, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', data => { stderr += data; });
  const client = new Client({ name: 'crew-offline-test', version: '1' });
  t.after(async () => {
    await client.close(); await transport.close(); await new Promise(resolve => http.close(resolve));
    assert(home.startsWith(join(tmpdir(), 'crew-fast-mcp-'))); rmSync(home, { recursive: true, force: true });
  });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.filter(c => c.type === 'text').map(c => c.text).join('') ?? '';
    let data; try { data = JSON.parse(text); } catch {}
    return { ...result, text, data };
  };
  return { client, call, seen, state, home, stderr: () => stderr };
}

test('real source MCP schemas, policy, escalation, overrides and fail-closed boundaries (offline mock Hub)', async t => {
  const f = await fixture(t);
  const config = async patch => { const result = await f.call('dsh_worker_config', patch); assert(!result.isError, result.text); return result.data; };
  const dispatch = (name, patch = {}) => f.call(name, { task: 'OFFLINE FIXTURE ONLY', cwd: f.home, allow_concurrent_cwd: true, ...patch });
  const initial = await config({});
  assert.equal(initial.pro_fast_mode, false); assert.equal(initial.flash_fast_mode, false);
  assert.equal(initial.bindings.pro.fast_mode, false);
  const tools = await f.client.listTools();
  for (const name of ['dsh_run_worker', 'dsh_spawn_worker', 'dsh_worker_probe']) {
    assert.equal(tools.tools.find(t => t.name === name).inputSchema.properties.fast_mode.type, 'boolean');
  }
  for (const value of ['true', null, 1]) {
    const result = await f.call('dsh_worker_config', { pro_fast_mode: value });
    assert.equal(result.isError, true); assert.equal((await config({})).pro_fast_mode, false);
  }
  await config({ pro_fast_mode: true, flash_fast_mode: false, tier_policy: 'pro-only' });
  let result = await dispatch('dsh_spawn_worker', { tier: 'flash' });
  assert(!result.isError, result.text); assert.equal(f.seen.jobs.at(-1).tier, 'pro'); assert.equal(f.seen.jobs.at(-1).fast_mode, true);
  assert.deepEqual(f.seen.checks.at(-1), { provider: 'openai-codex', model: 'pro-fixture' });
  result = await dispatch('dsh_spawn_worker', { tier: 'flash', fast_mode: false });
  assert(!result.isError, result.text); assert.equal(f.seen.jobs.at(-1).fast_mode, false);
  await config({ tier_policy: 'auto', escalate_on_failure: true }); f.state.failFlash = true;
  const before = f.seen.jobs.length;
  result = await dispatch('dsh_run_worker', { tier: 'flash', timeout_seconds: 1 });
  assert(!result.isError, result.text); assert.equal(result.data.escalated, true);
  assert.deepEqual(f.seen.jobs.slice(before).map(j => [j.tier, j.fast_mode]), [['flash', false], ['pro', true]]);
  const beforeOverride = f.seen.jobs.length;
  result = await dispatch('dsh_run_worker', { tier: 'flash', fast_mode: false, timeout_seconds: 1 });
  assert(!result.isError, result.text);
  assert.deepEqual(f.seen.jobs.slice(beforeOverride).map(j => j.fast_mode), [false, false]);
  await config({ flash_fast_mode: true, pro_fast_mode: false });
  const beforeSkip = f.seen.jobs.length;
  result = await dispatch('dsh_run_worker', { tier: 'flash', timeout_seconds: 1 });
  assert(!result.isError, result.text);
  assert.equal(result.data.status, 'failed');
  assert.equal(result.data.escalation_skipped, 'fast_mode_would_be_disabled');
  assert.equal(result.data.escalated, undefined);
  assert.deepEqual(f.seen.jobs.slice(beforeSkip).map(j => [j.tier, j.fast_mode]), [['flash', true]], 'Fast failure must not automatically retry Standard');
  const beforeExplicitFalse = f.seen.jobs.length;
  result = await dispatch('dsh_run_worker', { tier: 'flash', fast_mode: false, timeout_seconds: 1 });
  assert(!result.isError, result.text); assert.equal(result.data.escalated, true);
  assert.deepEqual(f.seen.jobs.slice(beforeExplicitFalse).map(j => j.fast_mode), [false, false]);
  const beforeTrue = f.seen.jobs.length;
  result = await dispatch('dsh_run_worker', { tier: 'flash', fast_mode: true, timeout_seconds: 1 });
  assert(!result.isError, result.text); assert.deepEqual(f.seen.jobs.slice(beforeTrue).map(j => j.fast_mode), [true, true]);
  await config({ pro_fast_mode: true });
  const beforeFastDestination = f.seen.jobs.length;
  result = await dispatch('dsh_run_worker', { tier: 'flash', timeout_seconds: 1 });
  assert(!result.isError, result.text); assert.equal(result.data.escalated, true);
  assert.deepEqual(f.seen.jobs.slice(beforeFastDestination).map(j => j.fast_mode), [true, true]);

  f.state.failFlash = false; await config({ flash_fast_mode: false, pro_fast_mode: true });
  for (const capability of ['old', 'wrong_protocol', 'unsupported']) {
    f.state.capability = capability;
    const beforeJobs = f.seen.jobs.length;
    result = await dispatch('dsh_spawn_worker', { tier: 'pro', allow_concurrent_cwd: false });
    assert.equal(result.isError, true); assert.match(result.text, /Fast mode/); assert.equal(f.seen.jobs.length, beforeJobs);
  }
  // Explicit false remains usable even against an old Hub with no Fast protocol.
  result = await dispatch('dsh_spawn_worker', { tier: 'pro', fast_mode: false });
  assert(!result.isError, result.text);
  f.state.capability = 'supported'; f.state.rejectJobs = true;
  const beforeFailure = f.seen.jobs.length;
  result = await dispatch('dsh_spawn_worker', { tier: 'pro' });
  assert.equal(result.isError, true); assert.equal(f.seen.jobs.length, beforeFailure + 1, 'one transport failure must not retry or fallback');
  assert.match(result.text, /fixture job transport failure/); f.state.rejectJobs = false;
  result = await f.call('dsh_worker_probe', { tier: 'pro' });
  assert(!result.isError, result.text); assert.equal(f.seen.probes.at(-1).fast_mode, true);
  result = await f.call('dsh_worker_probe', { tier: 'pro', fast_mode: false });
  assert(!result.isError, result.text); assert.equal(f.seen.probes.at(-1).fast_mode, false);
  await config({ mode: 'standalone' });
  const beforeStandalone = f.seen.jobs.length;
  for (const name of ['dsh_run_worker', 'dsh_spawn_worker']) {
    result = await dispatch(name, { tier: 'pro' });
    assert.equal(result.isError, true); assert.match(result.text, /Fast mode requires/);
    result = await dispatch(name, { worker: 'agy', fast_mode: true });
    assert.equal(result.isError, true); assert.match(result.text, /external CLI/);
    // No tier preference applies to worker=; avoid launching any CLI by using an unknown profile.
    result = await dispatch(name, { worker: 'no-such-offline-profile' });
    assert.equal(result.isError, true); assert.doesNotMatch(result.text, /Fast mode requires/);
  }
  assert.equal(f.seen.jobs.length, beforeStandalone);
  // Standalone false retains old startup failure (no credentials), never a live call.
  result = await dispatch('dsh_spawn_worker', { tier: 'pro', fast_mode: false });
  assert.equal(result.isError, true); assert.doesNotMatch(result.text, /Fast mode requires/);
  const status = await f.call('dsh_worker_status');
  assert(!status.isError, status.text);
  assert.equal(status.data.filter(j => j.kind === 'cwd-lock').length, 0);
  await config({ mode: 'auto', reset: true });
  assert.equal((await config({})).pro_fast_mode, false);
});


test('auto mode with initially unavailable Hub refuses Fast without standalone fallback', async t => {
  const f = await fixture(t, { hubUp: false });
  const config = await f.call('dsh_worker_config', { pro_fast_mode: true });
  assert.equal(config.data.hub_reachable, false);
  for (const name of ['dsh_run_worker', 'dsh_spawn_worker']) {
    const result = await f.call(name, { task: 'OFFLINE FIXTURE ONLY', cwd: f.home, tier: 'pro' });
    assert.equal(result.isError, true); assert.match(result.text, /Fast mode requires/);
  }
  assert.equal(f.seen.checks.length, 0); assert.equal(f.seen.jobs.length, 0);
  const status = await f.call('dsh_worker_status');
  assert.deepEqual(status.data, [], 'no fallback jobs or memory locks');
});
