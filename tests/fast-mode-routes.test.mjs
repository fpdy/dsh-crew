import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const hubUrl = new URL('../src/hub/index.mjs', import.meta.url).href;
const installUrl = new URL('../src/install/install.mjs', import.meta.url).href;
const jobsUrl = new URL('../src/jobs.mjs', import.meta.url).href;
const cliUrl = new URL('../src/cli-workers.mjs', import.meta.url).href;

test('Hub Fast routes are loopback/method bounded, metadata-only, and follow global binding identity', () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-fast-routes-'));
  mkdirSync(join(home, '.config/dsh-crew'), { recursive: true });
  writeFileSync(join(home, '.config/dsh-crew/config.json'), JSON.stringify({ pro_provider: 'openai-codex', pro_model: 'priority-fixture', pro_fast_mode: true }));
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { existsSync, readdirSync } from 'node:fs';
      const { apply } = await import(${JSON.stringify(hubUrl)});
      const { writeGlobalConfig } = await import(${JSON.stringify(installUrl)});
      const { startJob, listJobs } = await import(${JSON.stringify(jobsUrl)});
      const { startCliJob } = await import(${JSON.stringify(cliUrl)});
      const routes = new Map(); let streams = 0, creations = 0, lookups = [];
      const llm = { listProviders: () => [], async resolveModelInfo(provider, model, signal) {
        lookups.push([provider, model]); return model === 'priority-fixture' ? { serviceTiers: ['priority'] } : {};
      }, async *stream(options) { streams++; assert.equal(options.serviceTier, 'priority'); yield { type: 'finish', reason: { kind: 'stop' } }; } };
      const webServer = { register(route) { routes.set(route.path, route.handler); return () => {}; } };
      const ctx = { llm, get() {}, on() { return () => {}; }, logger: { warn() {}, info() {} },
        tools: { register() { return () => {}; } }, effect(fn) { return fn(); },
        inject(keys, fn) { fn({ webServer }); }, agents: { async create() { creations++; throw new Error('must not create'); } } };
      const dispose = await apply(ctx);
      async function call(path, method = 'GET', body, remoteAddress = '127.0.0.1') {
        const req = { method, url: '/_dsh/dsh-crew' + path, socket: { remoteAddress }, headers: { host: '127.0.0.1', 'content-type': 'application/json' },
          async *[Symbol.asyncIterator]() { if (body !== undefined) yield JSON.stringify(body); } };
        let response;
        const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(raw) { response = { status: this.status, headers: this.headers, body: JSON.parse(raw) }; } };
        await routes.get('/_dsh/dsh-crew' + path)(req, res); return response;
      }
      let response = await call('/fast-mode/status');
      assert.equal(response.status, 200); assert.equal(response.body.protocol, 1);
      assert.deepEqual(response.body.tiers.pro, { provider: 'openai-codex', model: 'priority-fixture', supported: true });
      assert.deepEqual(response.body.tiers.flash, { provider: 'deepseek-official', model: 'deepseek-v4-flash', supported: false, reason: 'unsupported_provider' });
      assert.deepEqual(lookups, [['openai-codex', 'priority-fixture']]); assert.equal(streams, 0);
      assert.equal((await call('/fast-mode/status', 'POST')).status, 405);
      assert.equal((await call('/fast-mode/status', 'HEAD')).status, 405);
      assert.equal((await call('/fast-mode/status', 'GET', undefined, '192.0.2.3')).status, 403);
      writeGlobalConfig({ pro_model: 'plain-fixture' });
      response = await call('/fast-mode/status');
      assert.deepEqual(response.body.tiers.pro, { provider: 'openai-codex', model: 'plain-fixture', supported: false, reason: 'priority_not_supported' });
      response = await call('/fast-mode/check', 'POST', { provider: 'openai-codex', model: 'priority-fixture' });
      assert.equal(response.body.supported, true); assert.equal(response.body.protocol, 1); assert.equal(streams, 0);
      assert.equal((await call('/fast-mode/check')).status, 405);
      assert.equal((await call('/fast-mode/check', 'POST', {})).status, 400);
      assert.equal((await call('/fast-mode/check', 'POST', { provider: 'openai-codex', model: 'priority-fixture' }, '192.0.2.3')).status, 403);
      response = await call('/worker-probe', 'POST', { provider: 'openai-codex', model: 'plain-fixture', fast_mode: true });
      assert.equal(response.body.result.status, 'fast_mode_unsupported'); assert.equal(streams, 0);
      assert.equal((await call('/worker-probe', 'POST', { provider: 'openai-codex', model: 'priority-fixture', fast_mode: 'true' })).status, 400);
      response = await call('/worker-probe', 'POST', { provider: 'openai-codex', model: 'priority-fixture', fast_mode: true });
      assert.equal(response.body.result.fast_mode_requested, true); assert.equal(response.body.result.response_service_tier, null); assert.equal(streams, 1);
      delete llm.resolveModelInfo;
      response = await call('/jobs', 'POST', { task: 'offline', cwd: ${JSON.stringify(home)}, tier: 'pro', fast_mode: true });
      assert.equal(response.status, 400); assert.equal(creations, 0); assert.equal(streams, 1);
      response = await call('/fast-mode/status'); assert.equal(response.body.tiers.pro.reason, 'host_metadata_unavailable');
      for (const start of [startJob, startCliJob]) {
        await assert.rejects(start({ task: 'offline', cwd: ${JSON.stringify(home)}, worker: 'agy', fast_mode: true }), /Fast mode requires/);
        await assert.rejects(start({ task: 'offline', cwd: ${JSON.stringify(home)}, worker: 'agy', fast_mode: 'true' }), /boolean/);
      }
      assert.equal(listJobs().length, 0);
      assert(!existsSync(${JSON.stringify(join(home, '.config/dsh-crew/status.d'))}), 'no failed Fast dispatch may publish a job');
      await dispose();
    `], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } finally {
    assert(home.startsWith(join(tmpdir(), 'crew-fast-routes-'))); rmSync(home, { recursive: true, force: true });
  }
});
