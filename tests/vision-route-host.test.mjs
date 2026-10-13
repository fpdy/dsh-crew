// Optional offline contract tests against an already-built DSH installation.
// Supply DSH_HOST_ANCHOR=/absolute/path/to/the/runtime/project/package.json.
// No live Host, credentials, sessions, HTTP server or model API is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installVisionRoute, VISION_PROVIDER, VISION_ROUTE_ERROR } from '../src/vision-route.mjs';

const anchor = process.env.DSH_HOST_ANCHOR;
const skip = !anchor && 'Set DSH_HOST_ANCHOR to run against a built host';

async function host(t) {
  assert(isAbsolute(anchor), 'DSH_HOST_ANCHOR must be an absolute manifest path');
  const require = createRequire(anchor);
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
  const { LlmRuntime } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  t.after(() => ctx.fiber.dispose());
  return ctx;
}

function nativeAdapter(generation, seen) {
  const model = (provider, id) => ({ provider, id, name: id, inputModalities: ['text', 'image'],
    reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'high' } });
  const stream = async function* (options) {
    seen.push({ generation, options });
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  const policy = Object.freeze({ mode: 'normal', maxRetries: 2, retryableCodes: Object.freeze(['RATE_LIMITED']),
    initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 });
  const pricing = Object.freeze({ priceImages: (images) => images.map(() => ({ visualTokens: 17, text: '' })) });
  return {
    providerInfo: (provider) => ({ id: provider, name: 'Offline native fixture' }),
    providerRetryPolicy: () => policy,
    imageRequestPricing: () => pricing,
    listModels: async (provider) => [model(provider, 'model')],
    resolveModel: async (provider, id) => model(provider, id),
    prepareCall: async (provider, id) => ({ model: model(provider, id), stream }),
    stream,
  };
}

async function drain(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; }

for (const order of ['before Crew', 'after Crew']) {
  test(`real host: wraps append-based model selection installed ${order}`, { skip }, async (t) => {
    const ctx = await host(t);
    let selection, resolved;
    const route = async (_payload, next) => {
      const seed = await next();
      // Same await-next/provider-override shape as installModelSelection.
      resolved = Object.freeze({ ...seed, ...selection });
      return resolved;
    };
    if (order === 'before Crew') t.after(ctx.on('agent/request', route));
    t.after(installVisionRoute(ctx));
    if (order === 'after Crew') t.after(ctx.on('agent/request', route));

    selection = { provider: VISION_PROVIDER, model: 'alias-selected' };
    await assert.rejects(ctx.waterfall('agent/request', {}, async () => ({ provider: 'native-fixture', model: 'stale-seed' })),
      { code: VISION_ROUTE_ERROR });
    selection = { provider: 'native-fixture', model: 'native-selected' };
    const image = Object.freeze({ type: 'image', attachment: Object.freeze({ name: 'native.png', id: 'offline' }) });
    const seed = Object.freeze({ provider: VISION_PROVIDER, model: 'stale-alias', maxTokens: 456,
      messages: Object.freeze([{ role: 'user', content: Object.freeze([image]) }]) });
    const result = await ctx.waterfall('agent/request', {}, async () => seed);
    assert.equal(result, resolved);
    assert.equal(result.provider, 'native-fixture');
    assert.equal(result.maxTokens, 456);
    assert.equal(result.messages[0].content[0], image);
    assert.equal(seed.provider, VISION_PROVIDER);
  });
}

test('real host: alias is not advertised and cannot reach the defective adapter methods', { skip }, async (t) => {
  const ctx = await host(t);
  const remove = installVisionRoute(ctx);
  t.after(remove);
  assert(!ctx.llm.listProviders().some((p) => p.id === VISION_PROVIDER));
  assert.equal(ctx.llm.imageRequestPricing(VISION_PROVIDER, 'model'), undefined);
  await assert.rejects(ctx.llm.prepareCall({ provider: VISION_PROVIDER, model: 'model' }), { code: 'NO_ADAPTER' });
  const chunks = await drain(ctx.llm.stream({ provider: VISION_PROVIDER, model: 'model', messages: [] }));
  assert(!JSON.stringify(chunks).includes('is not a function'));
  assert.equal(chunks.at(-1).reason.failure.code, 'NO_ADAPTER');
  await assert.rejects(ctx.waterfall('agent/request', {}, async () => ({ provider: VISION_PROVIDER, model: 'model' })),
    { code: VISION_ROUTE_ERROR });
});

test('real host: native prepared/direct calls, controls, pricing and registration snapshots remain native', { skip }, async (t) => {
  const ctx = await host(t);
  const seen = [];
  const disposeA = ctx.llm.registerAdapter(['native-fixture'], nativeAdapter('A', seen));
  const retryPolicy = ctx.llm.providerRetryPolicy('native-fixture');
  const pricing = ctx.llm.imageRequestPricing('native-fixture', 'model');
  const remove = installVisionRoute(ctx);
  t.after(remove);
  assert.equal(ctx.llm.providerRetryPolicy('native-fixture'), retryPolicy);
  assert.equal(retryPolicy.maxRetries, 2);
  assert.equal(ctx.llm.imageRequestPricing('native-fixture', 'model'), pricing);
  assert.deepEqual(pricing.priceImages([{}]), [{ visualTokens: 17, text: '' }]);
  assert.deepEqual(ctx.llm.listProviders().map((p) => p.id), ['native-fixture']);

  const config = { provider: 'native-fixture', model: 'model', reasoningEffort: 'max',
    maxTokens: 321, temperature: 0.3, stop: ['END'] };
  const prepared = await ctx.llm.prepareCall(config);
  disposeA();
  const disposeB = ctx.llm.registerAdapter(['native-fixture'], nativeAdapter('B', seen));
  t.after(disposeB);
  await drain(prepared.stream({ ...prepared.config, messages: [] }));
  assert.equal(seen[0].generation, 'A');
  for (const key of Object.keys(config)) assert.deepEqual(seen[0].options[key], config[key]);
  assert.throws(() => prepared.stream({ ...prepared.config, messages: [] }), { code: 'INVALID_PREPARED_CALL' });

  const nativeImage = Object.freeze({ type: 'image', attachment: Object.freeze({ id: 'offline', name: 'native.png' }) });
  const replayState = Object.freeze({ fixture: 'opaque-native-reasoning-state' });
  const messages = Object.freeze([
    Object.freeze({ role: 'user', content: Object.freeze([nativeImage]) }),
    Object.freeze({ role: 'assistant', content: Object.freeze([{ type: 'text', text: 'previous answer' }]),
      source: Object.freeze({ kind: 'model', provider: 'native-fixture', model: 'model', replayState }) }),
  ]);
  const next = await ctx.llm.prepareCall({ provider: 'native-fixture', model: 'model' });
  assert.throws(() => next.stream({ ...next.config, maxTokens: 999, messages }), { code: 'INVALID_PREPARED_CALL' });
  await drain(next.stream({ ...next.config, messages }));
  assert.equal(seen[1].generation, 'B');
  assert.equal(seen[1].options.reasoningEffort, 'high');
  assert.equal(seen[1].options.messages[0].content[0], nativeImage);
  assert.equal(seen[1].options.messages[1].source.replayState, replayState);
  await drain(ctx.llm.stream({ ...config, messages }));
  assert.equal(seen[2].generation, 'B');
  assert.deepEqual(seen[2].options.stop, config.stop);
  assert.equal(seen[2].options.messages[0].content[0], nativeImage);
  assert.equal(seen[2].options.messages[1].source.replayState, replayState);
});
