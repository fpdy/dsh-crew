import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fastModeSupport, requireFastModeSupport, resolveFastMode, validateFastModeConfig, terminalResponseServiceTier, requireFastHub } from '../src/fast-mode.mjs';
import { describeBindings } from '../src/tier-binding.mjs';
import { WorkerRegistry, installModelSelection } from '../src/hub/index.mjs';
import { probeProvider } from '../src/provider-probe.mjs';

const route = { provider: 'openai-codex', model: 'fixture-model' };
const finish = (tier, reason = 'stop') => ({ type: 'chunk', time: 1, chunk: { type: 'finish', reason: { kind: reason }, ...(tier === undefined ? {} : { responseServiceTier: tier }) } });

test('Fast settings are strict booleans, default off, and explicit false wins', () => {
  assert.equal(resolveFastMode('pro'), false);
  assert.equal(resolveFastMode('pro', { pro_fast_mode: true }), true);
  assert.equal(resolveFastMode('pro', { pro_fast_mode: true }, false), false);
  assert.equal(resolveFastMode('flash', { flash_fast_mode: false }, true), true);
  for (const value of [null, 0, 1, 'true', 'false', {}, []]) {
    assert.throws(() => validateFastModeConfig({ pro_fast_mode: value }), /must be a boolean/);
    assert.throws(() => resolveFastMode('flash', {}, value), /must be a boolean/);
  }
  assert.equal(describeBindings({ pro_fast_mode: true }).pro.fast_mode, true);
  assert.equal(describeBindings({}).flash.fast_mode, false);
  assert.doesNotThrow(() => validateFastModeConfig({ legacy: 'kept' }));
  assert.throws(() => requireFastHub('standalone', true), /requires a reachable/);
  assert.throws(() => requireFastHub('cli', true), /external CLI/);
  assert.doesNotThrow(() => requireFastHub('standalone', false));
});

test('capability lookup uses exact public metadata signature and never a request', async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  const llm = { async resolveModelInfo(provider, model, actualSignal) {
    calls++; assert.equal(provider, route.provider); assert.equal(model, route.model); assert.equal(actualSignal, signal);
    return { serviceTiers: ['priority'] };
  }, stream() { throw new Error('must not request'); }, prepareCall() { throw new Error('must not prepare'); } };
  assert.deepEqual(await fastModeSupport(llm, route, signal), { supported: true });
  assert.equal(calls, 1);
  assert.deepEqual(await fastModeSupport(llm, { ...route, provider: 'openai' }), { supported: false, reason: 'unsupported_provider' });
  assert.equal(calls, 1, 'unsupported providers cannot enter adapter lookup');
  assert.deepEqual(await fastModeSupport({}, route), { supported: false, reason: 'host_metadata_unavailable' });
  for (const info of [{}, { serviceTiers: ['standard'] }, { serviceTiers: 'priority' }]) {
    assert.equal((await fastModeSupport({ resolveModelInfo: async () => info }, route)).supported, false);
  }
  const failed = { resolveModelInfo: async () => { throw new Error('credential=secret'); } };
  assert.deepEqual(await fastModeSupport(failed, route), { supported: false, reason: 'model_metadata_unavailable' });
  await assert.rejects(requireFastModeSupport(failed, route), /model_metadata_unavailable/);
});

test('Crew selection wraps inherited controls, removes native tier, and leaves images intact', async () => {
  for (const fastMode of [false, true]) {
    const handlers = new Map(); let resets = 0;
    const ctx = { on(name, handler, options) { handlers.set(name, handler); if (name === 'agent/request') assert.deepEqual(options, { prepend: true }); } };
    const selection = { current: { ...route, reasoningEffort: 'max', fast_mode: fastMode } };
    installModelSelection(ctx, selection, () => resets++);
    await handlers.get('system-prompt/assemble')({}, {}, async () => ({ variables: { keep: true } }));
    const image = Object.freeze({ type: 'image', attachment: { id: 'offline' } });
    const native = Object.freeze({ provider: 'native', model: 'native', serviceTier: 'priority', reasoningEffort: 'high',
      messages: [{ role: 'user', content: [image] }], temperature: 0.5, maxTokens: 321, stop: ['END'] });
    const result = await handlers.get('agent/request')({}, async () => native);
    assert.equal(result.provider, route.provider); assert.equal(result.reasoningEffort, 'max');
    assert.equal(Object.hasOwn(result, 'serviceTier'), fastMode);
    if (fastMode) assert.equal(result.serviceTier, 'priority');
    assert.equal(result.messages, native.messages); assert.equal(result.messages[0].content[0], image);
    assert.equal(result.stop, native.stop); assert.equal(result.temperature, 0.5); assert.equal(result.maxTokens, 321);
    assert.equal(native.serviceTier, 'priority'); assert.equal(resets, 1);
  }
});

function registryFixture(info = { serviceTiers: ['priority'] }) {
  const handlers = new Map(); const writes = []; let creations = 0, loaderCalls = 0;
  const agent = { session: {}, async whenIdle() {}, followup() {} };
  const ctx = { llm: { async resolveModelInfo() { return info; } }, sessions: { async flush() {} },
    get(name) { if (name === 'loader') return { async await() { loaderCalls++; } }; },
    agents: { async create(options) { creations++; await options.setup({ on(name, fn) { handlers.set(name, fn); } }); return { agent, async dispose() {} }; } } };
  const registry = new WorkerRegistry(ctx, { publish(rows) { writes.push(structuredClone(rows)); } });
  return { registry, handlers, writes, creations: () => creations, loaderCalls: () => loaderCalls };
}

test('unsupported/legacy Hub Fast is refused before job creation, loader or publication', async () => {
  for (const metadata of [{}, { serviceTiers: [] }]) {
    const f = registryFixture(metadata);
    await assert.rejects(f.registry.spawn({ task: 'offline fixture', cwd: '/fixture', ...route, fast_mode: true }), /Fast mode unavailable/);
    assert.equal(f.registry.jobs.size, 0); assert.equal(f.creations(), 0); assert.equal(f.loaderCalls(), 0); assert.equal(f.writes.length, 0);
  }
  const f = registryFixture();
  await assert.rejects(f.registry.spawn({ task: 'offline', cwd: '/fixture', fast_mode: true }), /unsupported_provider/);
  await assert.rejects(f.registry.spawn({ task: 'offline', cwd: '/fixture', ...route, fast_mode: 'true' }), /boolean/);
  assert.equal(f.registry.jobs.size, 0);
});

test('Hub tier Fast fallback, explicit false, and persisted latest-attempt observations', async () => {
  const f = registryFixture();
  f.registry.getConfig = () => ({ pro_provider: route.provider, pro_model: route.model, pro_fast_mode: true });
  const job = await f.registry.spawn({ task: 'offline', cwd: '/fixture', tier: 'pro' });
  await job.promise;
  assert.equal(f.registry.view(job).fast_mode_requested, true);
  assert.equal(f.registry.view(job).response_service_tier, null);
  const emit = (type, data) => f.handlers.get('session/event')({}, { type, data });
  emit('assistant/message', { stream: [finish('priority')], message: { content: [] } });
  assert.equal(f.registry.view(job).response_service_tier, 'priority');
  assert.equal(f.writes.at(-1)[0].response_service_tier, 'priority');
  emit('step/start', { turn: 1, step: 2 });
  assert.equal(job.response_service_tier, null);
  emit('assistant/message', { stream: [finish('unknown-future-tier')], message: { content: [] } });
  assert.equal(job.response_service_tier, 'unknown-future-tier');
  emit('assistant/attempt', { stream: [], usage: { cost: { total: 100 } } });
  assert.equal(job.response_service_tier, null, 'failed/absent terminal resets previous attempt');
  emit('assistant/attempt', { stream: [finish('default', 'error')] });
  assert.equal(job.response_service_tier, 'default', 'an error terminal can still report raw response metadata');
  await f.handlers.get('system-prompt/assemble')({}, {}, async () => ({ variables: {} }));
  await f.handlers.get('agent/request')({}, async () => route);
  assert.equal(job.response_service_tier, null, 'every request retry resets observation');
  emit('assistant/message', { stream: [finish(undefined)], message: { content: [] }, usage: { cost: { total: 10 } } });
  assert.equal(job.response_service_tier, null);
  const plain = await f.registry.spawn({ task: 'offline', cwd: '/fixture', tier: 'pro', fast_mode: false });
  await plain.promise;
  assert.equal(plain.fast_mode_requested, false);
});

test('only terminal compact raw metadata is service-tier evidence', () => {
  assert.equal(terminalResponseServiceTier([{ type: 'usage', responseServiceTier: 'priority' }]), null);
  assert.equal(terminalResponseServiceTier([{ type: 'chunk', chunk: { type: 'usage', responseServiceTier: 'priority' } }]), null);
  assert.equal(terminalResponseServiceTier([finish('priority'), finish(undefined)]), null);
  assert.equal(terminalResponseServiceTier([finish(3)]), null);
  assert.equal(terminalResponseServiceTier([finish('something-new')]), 'something-new');
});

test('probe Fast true honors metadata and uses priority while false keeps native defaults', async () => {
  for (const fastMode of [false, true]) {
    let requests = 0;
    const llm = { async resolveModelInfo() { return { serviceTiers: ['priority'] }; }, async *stream(options) {
      requests++; assert.equal(options.serviceTier, fastMode ? 'priority' : undefined); assert.equal(Object.hasOwn(options, 'fast_mode'), false);
      const nonce = /nonce ([a-f0-9]+)/.exec(options.messages[0].content[0].text)[1];
      yield { type: 'block-end', block: { type: 'tool-call', name: 'dsh_crew_probe_noop', arguments: JSON.stringify({ nonce }) } };
      yield { type: 'finish', reason: { kind: 'tool-calls' }, responseServiceTier: 'default' };
    } };
    const result = await probeProvider(llm, { ...route, fast_mode: fastMode });
    assert.equal(requests, 1); assert.equal(result.fast_mode_requested, fastMode); assert.equal(result.response_service_tier, 'default'); assert.equal(result.status, 'verified');
  }
  let requested = false;
  const result = await probeProvider({ async *stream() { requested = true; } }, { ...route, fast_mode: true });
  assert.equal(requested, false); assert.equal(result.status, 'fast_mode_unsupported'); assert.equal(result.response_service_tier, null);
});

test('probe bounds metadata and a late lookup cannot start a model request', async () => {
  let release, streams = 0, signal;
  const llm = { resolveModelInfo(_provider, _model, incomingSignal) {
    signal = incomingSignal; return new Promise(resolve => { release = resolve; });
  }, async *stream() { streams++; } };
  const result = await probeProvider(llm, { ...route, fast_mode: true }, { timeoutMs: 100 });
  assert.equal(result.status, 'timeout'); assert.equal(result.response_service_tier, null);
  assert.equal(signal.aborted, true);
  release({ serviceTiers: ['priority'] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(streams, 0);
});
