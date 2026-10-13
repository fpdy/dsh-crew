import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const moduleUrl = new URL('../src/multimodal.mjs', import.meta.url);
let fixtureId = 0;
const wallSetTimeout = globalThis.setTimeout, wallClearTimeout = globalThis.clearTimeout;
const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitFor(check, label) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => wallSetTimeout(r, 10));
  }
}

// A hard wall-clock bound keeps regressions from hanging the test process.
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = wallSetTimeout(() => reject(new Error('operation did not settle')), 4000); }),
    ]);
  } finally { wallClearTimeout(timer); }
}

async function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'crew-multimodal-cancel-'));
  const home = join(root, 'home'), bin = join(root, 'bin');
  mkdirSync(home); mkdirSync(bin);
  const image = join(root, 'image.png');
  writeFileSync(image, 'offline fake image');
  const calls = join(root, 'calls'), pids = join(root, 'pids');
  const cache = join(home, '.config', 'dsh-crew', 'vision-cache.json');
  const env = {
    HOME: home, PATH: `${bin}:/usr/bin:/bin`, DEEPSEEK_API_KEY: '', DEEPSEEK_BASE_URL: 'https://native.invalid',
    CREW_TEST_CALLS: calls, CREW_TEST_PIDS: pids, CREW_TEST_MODE: 'success',
  };
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const oldFetch = globalThis.fetch, oldWarn = console.warn;
  const warnings = [];
  Object.assign(process.env, env);
  globalThis.fetch = async () => { throw new Error('Unexpected fetch: real network is forbidden'); };
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    // HOME MUST be installed before import: CONFIG_DIR and CACHE_FILE are hoisted.
    // A distinct module URL prevents a prior fixture's cache/.env from being reused.
    const bridge = await import(`${moduleUrl.href}?offline-fixture=${++fixtureId}`);
    const script = `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
fs.appendFileSync(process.env.CREW_TEST_CALLS, require('node:path').basename(process.argv[1]) + '\\n');
const mode = process.env.CREW_TEST_MODE;
if (mode !== 'tree' && mode !== 'early') fs.writeFileSync(process.env.CREW_TEST_PIDS, JSON.stringify([process.pid]));
if (mode === 'tree' || mode === 'early') {
  const kid = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'inherit' });
  fs.writeFileSync(process.env.CREW_TEST_PIDS, JSON.stringify([process.pid, kid.pid]));
  if (mode === 'early') { console.log('early answer'); process.exit(0); }
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (mode.startsWith('imagegen-')) {
  if (mode !== 'imagegen-missing') fs.writeFileSync(process.argv[2], 'generated offline image');
  const out = mode === 'imagegen-stderr' ? '' : 'x'.repeat(2 * 1024 * 1024) + ' generation-stdout-tail';
  const err = mode === 'imagegen-stdout' ? '' : 'x'.repeat(20000) + ' generation-diagnostic-tail';
  process.stdout.write(out, () => process.stderr.write(err, () => process.exit(mode === 'imagegen-failure' ? 7 : 0)));
} else if (mode === 'failure') {
  process.stderr.write('x'.repeat(20000) + ' diagnostic-tail'); process.exit(7);
} else if (mode === 'overflow') {
  process.stdout.write('x'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000);
} else if (mode === 'stderr-only') {
  process.stderr.write('x'.repeat(10000), () => process.exit(0));
} else { console.log('offline answer'); }
`;
    for (const name of ['claude', 'codex', 'grok', 'agy', 'custom']) {
      const file = join(bin, name);
      writeFileSync(file, script); chmodSync(file, 0o755);
    }
    const custom = {
      id: 'offline-cli', type: 'cli',
      vision_command: `${quote(join(bin, 'custom'))} {image} {question}`,
      imagegen_command: `${quote(join(bin, 'custom'))} {output} {prompt}`,
    };
    const api = { id: 'offline-api', type: 'api', base_url: 'https://custom.invalid', models: ['offline-model'] };
    const config = (provider = 'offline-cli') => () => ({ vision_provider: provider, vision_model: 'default', custom_providers: [custom, api] });
    return await fn({ ...bridge, root, home, image, cache, calls, pids, warnings, config, custom, api,
      callCount: () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0,
      readPids: () => JSON.parse(readFileSync(pids, 'utf8')),
    });
  } finally {
    // Clean up even after a failed assertion; only PIDs recorded by our shims.
    if (existsSync(pids)) {
      for (const pid of JSON.parse(readFileSync(pids, 'utf8'))) {
        if (!Number.isInteger(pid) || pid <= 0) continue;
        try { process.kill(-pid, 'SIGKILL'); } catch {}
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
    globalThis.fetch = oldFetch; console.warn = oldWarn;
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.equal(resolve(root), root);
    assert.ok(root.startsWith(join(tmpdir(), 'crew-multimodal-cancel-')));
    rmSync(root, { recursive: true, force: true });
  }
}

function answerResponse(text = 'native offline answer') {
  return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: text } }] }) };
}

// Sequential fixtures deliberately isolate process.env/global.fetch and all
// filesystem state. No real credentials, CLIs, model requests, or ~/.config.
test('multimodal cancellation and failure safety (offline)', async (t) => {
  await t.test('pre-abort performs no config, image, cache, fetch, or CLI I/O', () => fixture(async (f) => {
    const controller = new AbortController();
    const reason = new Error('caller stopped'); controller.abort(reason);
    const getConfig = () => { throw new Error('config must not be read'); };
    for (const call of [
      () => f.describeFileWithProvenance(getConfig, '/missing/image.png', 'q', { signal: controller.signal }),
      () => f.describeFile(getConfig, '/missing/image.png', 'q', { signal: controller.signal }),
      () => f.createMultimodalTools(getConfig)[0].execute({ image_path: '/missing/image.png' }, { signal: controller.signal }),
    ]) await assert.rejects(call, (error) => error === reason);
    assert.equal(f.callCount(), 0); assert.equal(existsSync(join(f.home, '.config')), false);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }));

  await t.test('explicit falsy abort reasons remain rejections, never successful transcripts', () => fixture(async (f) => {
    for (const reason of [null, false, 0, '']) {
      const controller = new AbortController();
      globalThis.fetch = async () => new Promise(() => {});
      const pending = bounded(f.describeFileWithProvenance(f.config('offline-api'), f.image, String(reason), { signal: controller.signal }));
      controller.abort(reason);
      await assert.rejects(pending, (error) => error === reason);
    }
    assert.equal(f.callCount(), 0); assert.equal(existsSync(f.cache), false);
    process.env.CREW_TEST_MODE = 'tree';
    const controller = new AbortController();
    const pending = bounded(f.describeFileWithProvenance(f.config(), f.image, 'falsy CLI', { signal: controller.signal }));
    const rejected = assert.rejects(pending, (error) => error === null);
    await waitFor(() => existsSync(f.pids), 'falsy-reason CLI startup');
    controller.abort(null); await rejected;
    assert.equal(existsSync(f.cache), false);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }));

  await t.test('describe_image execution context abort reaches an in-flight CLI', () => fixture(async (f) => {
    process.env.CREW_TEST_MODE = 'tree';
    const controller = new AbortController();
    const [tool] = f.createMultimodalTools(f.config());
    const pending = bounded(tool.execute({ image_path: f.image, question: 'tool question' }, { signal: controller.signal }));
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await waitFor(() => existsSync(f.pids), 'tool CLI startup');
    controller.abort(); await rejected;
    assert.equal(existsSync(f.cache), false); assert.equal(f.callCount(), 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }));

  await t.test('config-triggered abort wins before file access', () => fixture(async (f) => {
    const controller = new AbortController();
    await assert.rejects(f.describeFileWithProvenance(() => { controller.abort(); return {}; }, '/missing.png', 'q', { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(f.callCount(), 0); assert.equal(existsSync(f.cache), false);
  }));

  for (const provider of ['offline-cli', 'claude-code', 'codex', 'grok', 'agy']) {
    await t.test(`${provider}: in-flight abort kills leader and descendant, rejects unchanged reason`, () => fixture(async (f) => {
      process.env.CREW_TEST_MODE = 'tree';
      const controller = new AbortController(), reason = new Error('permission: caller cancelled');
      const pending = bounded(f.describeFileWithProvenance(f.config(provider), f.image, 'q', { signal: controller.signal }));
      const rejected = assert.rejects(pending, (error) => error === reason);
      await waitFor(() => existsSync(f.pids), 'fake CLI startup');
      const [leader, descendant] = f.readPids();
      assert.ok(alive(leader)); assert.ok(alive(descendant));
      controller.abort(reason);
      await rejected;
      await waitFor(() => !alive(leader) && !alive(descendant), 'process-tree cleanup');
      assert.equal(f.callCount(), 1); assert.equal(existsSync(f.cache), false);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      // Same image/question must still run after cancellation, not use a
      // failure transcript or partial answer cached by the interrupted call.
      process.env.CREW_TEST_MODE = 'success';
      const next = await bounded(f.describeFileWithProvenance(f.config(provider), f.image, 'q'));
      assert.equal(next.text, 'offline answer'); assert.equal(next.cached, false);
      assert.equal(f.callCount(), 2);
    }));
  }

  for (const provider of ['claude-code', 'offline-api']) {
    await t.test(`${provider}: fetch abort propagates through headers/body with no fallback/cache`, () => fixture(async (f) => {
      process.env.DEEPSEEK_API_KEY = 'offline-not-a-credential';
      const controller = new AbortController();
      let transportSignal, started = false;
      globalThis.fetch = async (_url, options) => {
        transportSignal = options.signal;
        return { ok: true, text: () => { started = true; return new Promise(() => {}); } };
      };
      const pending = bounded(f.describeFileWithProvenance(f.config(provider), f.image, 'q', { signal: controller.signal }));
      const rejected = assert.rejects(pending, { name: 'AbortError' });
      await waitFor(() => started, 'response-body consumption');
      controller.abort();
      await rejected;
      assert.equal(transportSignal.aborted, true);
      assert.equal(transportSignal.reason, controller.signal.reason);
      assert.equal(f.callCount(), 0); assert.equal(existsSync(f.cache), false);
      assert.equal(f.warnings.length, 0);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      assert.equal(getEventListeners(transportSignal, 'abort').length, 0);
    }));
  }

  await t.test('late native response after caller abort cannot poison cache', () => fixture(async (f) => {
    process.env.DEEPSEEK_API_KEY = 'offline-not-a-credential';
    const controller = new AbortController(), reason = new Error('custom stop reason');
    let release, transportSignal;
    globalThis.fetch = (_url, options) => {
      transportSignal = options.signal;
      return new Promise((r) => { release = r; }); // intentionally ignores signal
    };
    const pending = bounded(f.describeFileWithProvenance(f.config('codex'), f.image, 'q', { signal: controller.signal }));
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    assert.equal(transportSignal.aborted, true);
    release(answerResponse('unwanted late answer'));
    await new Promise((r) => setImmediate(r));
    assert.equal(existsSync(f.cache), false); assert.equal(f.callCount(), 0);
    globalThis.fetch = async () => answerResponse('fresh answer');
    const next = await bounded(f.describeFileWithProvenance(f.config('codex'), f.image, 'q'));
    assert.equal(next.text, 'fresh answer'); assert.equal(next.cached, false);
    assert.deepEqual(Object.values(JSON.parse(readFileSync(f.cache, 'utf8'))), ['fresh answer']);
  }));

  await t.test('abort just as a valid API answer resolves still rejects, without caching', () => fixture(async (f) => {
    const controller = new AbortController();
    globalThis.fetch = async () => ({ ok: true, text: async () => {
      controller.abort(); return JSON.stringify({ choices: [{ message: { content: 'too late' } }] });
    } });
    await assert.rejects(f.describeFileWithProvenance(f.config('offline-api'), f.image, 'q', { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(existsSync(f.cache), false); assert.equal(f.callCount(), 0);
  }));

  await t.test('transport AbortError is never an ordinary native fallback', () => fixture(async (f) => {
    process.env.DEEPSEEK_API_KEY = 'offline-not-a-credential';
    const reason = new DOMException('transport stopped', 'AbortError');
    globalThis.fetch = async () => { throw reason; };
    await assert.rejects(f.describeFileWithProvenance(f.config('codex'), f.image, 'q'), (error) => error === reason);
    assert.equal(f.callCount(), 0); assert.equal(existsSync(f.cache), false); assert.equal(f.warnings.length, 0);
  }));

  for (const failure of ['http', 'network', 'empty', 'invalid-json']) {
    await t.test(`ordinary native ${failure} failure preserves CLI fallback and provenance`, () => fixture(async (f) => {
      process.env.DEEPSEEK_API_KEY = 'offline-not-a-credential';
      const controller = new AbortController();
      globalThis.fetch = async () => {
        if (failure === 'network') throw new Error('offline network failure');
        if (failure === 'http') return { ok: false, status: 503, text: async () => 'offline unavailable' };
        if (failure === 'invalid-json') return { ok: true, text: async () => 'not json' };
        return answerResponse('');
      };
      const result = await bounded(f.describeFileWithProvenance(f.config('codex'), f.image, 'q', { signal: controller.signal }));
      assert.equal(result.text, 'offline answer'); assert.match(result.provider, /codex \(native failed:/);
      assert.equal(result.cached, false); assert.equal(f.callCount(), 1);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      const cached = await f.describeFileWithProvenance(f.config('codex'), f.image, 'q');
      assert.equal(cached.cached, true); assert.equal(f.callCount(), 1);
    }));
  }

  await t.test('native deadline covers a hung response body and remains ordinary fallback', () => fixture(async (f) => {
    process.env.DEEPSEEK_API_KEY = 'offline-not-a-credential';
    let transportSignal;
    globalThis.fetch = async (_url, options) => {
      transportSignal = options.signal;
      return { ok: true, text: () => new Promise(() => {}) };
    };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let pending;
    try {
      pending = f.describeFileWithProvenance(f.config('codex'), f.image, 'q');
      await Promise.resolve();
      t.mock.timers.tick(240_000);
    } finally { t.mock.timers.reset(); }
    const result = await bounded(pending);
    assert.equal(result.text, 'offline answer'); assert.match(result.provider, /native failed:.*240000ms/);
    assert.equal(transportSignal.aborted, true); assert.equal(f.callCount(), 1);
    assert.equal(getEventListeners(transportSignal, 'abort').length, 0);
  }));

  await t.test('abort during native-to-CLI fallback stops the CLI without caching its partial output', () => fixture(async (f) => {
    process.env.DEEPSEEK_API_KEY = 'offline-not-a-credential';
    process.env.CREW_TEST_MODE = 'tree';
    globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => 'offline unavailable' });
    const controller = new AbortController();
    const pending = bounded(f.describeFileWithProvenance(f.config('codex'), f.image, 'q', { signal: controller.signal }));
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await waitFor(() => existsSync(f.pids), 'fallback CLI startup');
    controller.abort(); await rejected;
    assert.equal(f.callCount(), 1); assert.equal(existsSync(f.cache), false);
    await waitFor(() => f.readPids().every((pid) => !alive(pid)), 'fallback process cleanup');
  }));

  await t.test('CLI deadline rejects promptly and kills the entire group without waiting for close', () => fixture(async (f) => {
    process.env.CREW_TEST_MODE = 'tree';
    const controller = new AbortController();
    let pending;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      pending = bounded(f.describeFileWithProvenance(f.config('codex'), f.image, 'q', { signal: controller.signal }));
      const rejected = assert.rejects(pending, /codex timed out \(180000ms\)/);
      await waitFor(() => existsSync(f.pids), 'deadline CLI startup');
      t.mock.timers.tick(180_000);
      await rejected;
    } finally { t.mock.timers.reset(); }
    await waitFor(() => f.readPids().every((pid) => !alive(pid)), 'deadline process cleanup');
    assert.equal(existsSync(f.cache), false); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }));

  await t.test('oversized stderr-only success cannot cache a silently truncated answer', () => fixture(async (f) => {
    process.env.CREW_TEST_MODE = 'stderr-only';
    await assert.rejects(bounded(f.describeFileWithProvenance(f.config(), f.image, 'q')), /stderr-only answer exceeded 4096 bytes/);
    assert.equal(existsSync(f.cache), false);
  }));

  await t.test('leader early exit closes inherited pipes and kills lingering descendants', () => fixture(async (f) => {
    process.env.CREW_TEST_MODE = 'early';
    const result = await bounded(f.describeFileWithProvenance(f.config(), f.image, 'q'));
    assert.equal(result.text, 'early answer');
    const [leader, descendant] = f.readPids();
    await waitFor(() => !alive(leader) && !alive(descendant), 'early-exit descendants');
  }));

  await t.test('CLI failures retain only bounded useful diagnostics and never cache', () => fixture(async (f) => {
    process.env.CREW_TEST_MODE = 'failure';
    const controller = new AbortController();
    await assert.rejects(bounded(f.describeFileWithProvenance(f.config(), f.image, 'q', { signal: controller.signal })), (error) => {
      assert.match(error.message, /exited 7/); assert.match(error.message, /diagnostic-tail/);
      assert.ok(error.message.length < 500); return true;
    });
    assert.equal(existsSync(f.cache), false); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }));

  await t.test('excessive stdout fails promptly rather than returning/caching truncated answers', () => fixture(async (f) => {
    process.env.CREW_TEST_MODE = 'overflow';
    await assert.rejects(bounded(f.describeFileWithProvenance(f.config(), f.image, 'q')), /output exceeded 1048576 bytes/);
    assert.equal(existsSync(f.cache), false);
  }));

  await t.test('spawn failure releases caller listener with bounded error', () => fixture(async (f) => {
    process.env.PATH = join(f.root, 'nonexistent-bin');
    const controller = new AbortController();
    await assert.rejects(bounded(f.describeFileWithProvenance(f.config('codex'), f.image, 'q', { signal: controller.signal })), /codex spawn failed/);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0); assert.equal(existsSync(f.cache), false);
  }));

  await t.test('old three-argument calls and describe tool context preserve success/cache/provenance', () => fixture(async (f) => {
    const first = await bounded(f.describeFileWithProvenance(f.config(), f.image, 'q'));
    assert.equal(first.text, 'offline answer'); assert.equal(first.provider, 'offline-cli'); assert.equal(first.cached, false);
    assert.equal(await f.describeFile(f.config(), f.image, 'q'), 'offline answer');
    const controller = new AbortController();
    const cached = await f.describeFileWithProvenance(f.config(), f.image, 'q', { signal: controller.signal });
    assert.equal(cached.cached, true); assert.equal(f.callCount(), 1);
    const [tool] = f.createMultimodalTools(f.config());
    const result = await tool.execute({ image_path: f.image, question: 'q' }, { signal: controller.signal });
    assert.equal(result.ok, true); assert.equal(result.provider, 'offline-cli'); assert.match(result.text, /offline answer/);
    controller.abort();
    await assert.rejects(tool.execute({ image_path: f.image, question: 'q' }, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(f.callCount(), 1); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }));

  for (const mode of ['imagegen-stderr', 'imagegen-stdout']) {
    await t.test(`${mode}: noisy successful generation is determined by its saved file, not progress volume`, () => fixture(async (f) => {
      process.env.CREW_TEST_MODE = mode;
      const [, tool] = f.createMultimodalTools(f.config());
      const output = join(f.root, 'generated.png');
      const result = await bounded(tool.execute({ prompt: 'offline image', output_path: output, provider: 'offline-cli' }));
      assert.equal(result.ok, true); assert.match(result.text, /image saved:/);
      assert.equal(readFileSync(output, 'utf8'), 'generated offline image');
      assert.equal(f.callCount(), 1); assert.equal(existsSync(f.cache), false);
    }));
  }

  await t.test('noisy generation with a saved file still rejects a nonzero exit with bounded diagnostics', () => fixture(async (f) => {
    process.env.CREW_TEST_MODE = 'imagegen-failure';
    const [, tool] = f.createMultimodalTools(f.config());
    const output = join(f.root, 'generated.png');
    await assert.rejects(bounded(tool.execute({ prompt: 'offline image', output_path: output, provider: 'offline-cli' })), (error) => {
      assert.match(error.message, /exited 7/); assert.match(error.message, /generation-diagnostic-tail/);
      assert.ok(error.message.length < 500); return true;
    });
    assert.equal(readFileSync(output, 'utf8'), 'generated offline image');
    assert.equal(f.callCount(), 1); assert.equal(existsSync(f.cache), false);
  }));

  await t.test('noisy generation with exit zero still rejects a missing output file with bounded diagnostics', () => fixture(async (f) => {
    process.env.CREW_TEST_MODE = 'imagegen-missing';
    const [, tool] = f.createMultimodalTools(f.config());
    const output = join(f.root, 'generated.png');
    await assert.rejects(bounded(tool.execute({ prompt: 'offline image', output_path: output, provider: 'offline-cli' })), (error) => {
      assert.match(error.message, /was not created/); assert.match(error.message, /generation-stdout-tail/);
      assert.ok(error.message.length < 600); return true;
    });
    assert.equal(existsSync(output), false); assert.equal(f.callCount(), 1); assert.equal(existsSync(f.cache), false);
  }));

  await t.test('successful native/custom APIs detach listeners and cache only verified answers', () => fixture(async (f) => {
    process.env.DEEPSEEK_API_KEY = 'offline-not-a-credential';
    for (const provider of ['codex', 'offline-api']) {
      let count = 0, transportSignal;
      const controller = new AbortController();
      globalThis.fetch = async (_url, options) => { count++; transportSignal = options.signal; return answerResponse('verified answer'); };
      const first = await f.describeFileWithProvenance(f.config(provider), f.image, provider, { signal: controller.signal });
      assert.equal(first.text, 'verified answer'); assert.equal(first.cached, false);
      const next = await f.describeFileWithProvenance(f.config(provider), f.image, provider);
      assert.equal(next.cached, true); assert.equal(count, 1);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      assert.equal(getEventListeners(transportSignal, 'abort').length, 0);
    }
    assert.equal(f.callCount(), 0);
  }));
});
