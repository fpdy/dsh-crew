import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installVisionRoute, visionRouteStatus, VISION_PROVIDER, VISION_ROUTE_ERROR } from '../src/vision-route.mjs';

function fixture() {
  const handlers = new Map();
  const warnings = [];
  let removed = 0;
  const ctx = {
    logger: { warn: (text) => warnings.push(text) },
    on(name, fn, options) {
      assert.deepEqual(options, { prepend: true });
      assert(!handlers.has(name));
      handlers.set(name, fn);
      return () => { removed++; handlers.delete(name); };
    },
  };
  for (const name of ['llm', 'attachments', 'agents', 'sessions']) {
    Object.defineProperty(ctx, name, { get() { throw new Error(`${name} must not be accessed by the guard`); } });
  }
  return { ctx, handlers, warnings, removed: () => removed };
}

test('does not install an adapter or a global image-transcription hook', () => {
  const f = fixture();
  const dispose = installVisionRoute(f.ctx, () => { throw new Error('config must not be read'); });
  assert.deepEqual([...f.handlers.keys()], ['agent/request']);
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /generation-bound delegate/);
  assert.match(f.warnings[0], /describe_image/);
  dispose();
  dispose();
  assert.equal(f.removed(), 1);
  assert.equal(f.handlers.size, 0);
});

test('does not enable the unsafe alias on legacy or prepared-contract hosts', () => {
  for (const llm of [{}, { prepareCall() { throw new Error('must not be called'); } }]) {
    let registered = 0;
    llm.registerAdapter = () => { registered++; };
    const f = fixture();
    const ctx = { logger: f.ctx.logger, on: f.ctx.on, llm };
    installVisionRoute(ctx, () => ({ vision_provider: 'claude-code' }))();
    assert.equal(registered, 0);
  }
});

for (const provider of ['openai-codex', 'anthropic', 'deepseek-official', 'custom-native-route']) {
  test(`preserves native ${provider} request, images and controls by identity`, async () => {
    const f = fixture();
    const dispose = installVisionRoute(f.ctx);
    const image = Object.freeze({ type: 'image', attachment: Object.freeze({ id: 'offline', name: '日本語.png' }) });
    const message = Object.freeze({ role: 'user', content: Object.freeze([image]) });
    const request = Object.freeze({ provider, model: 'native-model', reasoningEffort: 'high',
      temperature: 0.3, maxTokens: 300, stop: Object.freeze(['END']), messages: Object.freeze([message]) });
    let nextCalls = 0;
    const result = await f.handlers.get('agent/request')({ signal: AbortSignal.abort() }, async () => {
      nextCalls++;
      return request;
    });
    assert.equal(result, request);
    assert.equal(result.messages[0].content[0], image);
    assert.equal(nextCalls, 1);
    dispose();
  });
}

test('rejects persisted alias selection with an actionable error, without silently rerouting', async () => {
  const f = fixture();
  const dispose = installVisionRoute(f.ctx);
  const request = Object.freeze({ provider: VISION_PROVIDER, model: 'previous-model', maxTokens: 111 });
  await assert.rejects(f.handlers.get('agent/request')({}, async () => request), (error) => {
    assert.equal(error.code, VISION_ROUTE_ERROR);
    assert.match(error.message, /image-capable model/);
    assert.match(error.message, /describe_image explicitly/);
    return true;
  });
  assert.equal(request.provider, VISION_PROVIDER);
  assert.equal(request.maxTokens, 111);
  dispose();
});

test('inspects resolved request, not stale agent options or previous session provider', async () => {
  const f = fixture();
  installVisionRoute(f.ctx);
  const handler = f.handlers.get('agent/request');
  await assert.rejects(handler({ agent: { options: { provider: 'openai-codex' } } },
    async () => ({ provider: VISION_PROVIDER, model: 'model' })), { code: VISION_ROUTE_ERROR });
  const native = Object.freeze({ provider: 'openai-codex', model: 'model' });
  assert.equal(await handler({ agent: { options: { provider: VISION_PROVIDER } } }, async () => native), native);
});

test('preserves upstream failures instead of replacing them with a transcript', async () => {
  const f = fixture();
  installVisionRoute(f.ctx);
  const error = new Error('upstream rejected request');
  await assert.rejects(f.handlers.get('agent/request')({}, async () => { throw error; }), (e) => e === error);
});

test('status is explicit, detached and contains no config or credentials', () => {
  const first = visionRouteStatus();
  assert.deepEqual(Object.keys(first).sort(), ['code', 'message', 'provider', 'registered', 'supported']);
  assert.equal(first.supported, false);
  assert.equal(first.registered, false);
  assert.equal(first.code, VISION_ROUTE_ERROR);
  first.supported = true;
  assert.equal(visionRouteStatus().supported, false);
});

test('hub and panel expose guard status without treating a stale Host as safe', () => {
  const hub = readFileSync(new URL('../src/hub/index.mjs', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8');
  assert.match(hub, /path: `\$\{ROUTE_BASE\}\/vision-route\/status`/);
  assert.match(hub, /\.\.\.visionRouteStatus\(\)/);
  assert.match(panel, /visionGuardActive \? copy\.visionRouteDisabled : copy\.visionRouteUnverified/);
  assert.match(panel, /r\.supported === false && r\.registered === false/);
  assert.match(panel, /setVisionGuardActive\(false\)/);
});
