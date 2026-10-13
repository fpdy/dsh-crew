import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFastSupport, canEnableFast, fastObservation } from '../src/client/fast-mode-view.ts';

const config = { mode: 'hub', pro_provider: 'openai-codex', pro_model: 'test-gpt' };
const status = () => ({ ok: true, protocol: 1, tiers: {
  pro: { provider: 'openai-codex', model: 'test-gpt', supported: true },
  flash: { provider: 'deepseek-official', model: 'deepseek-v4-flash', supported: false, reason: 'unsupported_provider' },
} });

test('Fast UI fails closed for stale, malformed and absent capabilities', () => {
  for (const value of [null, {}, { ok: true, protocol: 2 }, { ...status(), ok: false },
    { ...status(), tiers: { pro: status().tiers.pro } },
    { ...status(), tiers: { ...status().tiers, pro: { ...status().tiers.pro, supported: 'true' } } }]) {
    assert.equal(parseFastSupport(value), null);
  }
  assert.equal(canEnableFast(null, config, 'pro'), false);
});

test('Fast enablement requires exact current binding and compatible runtime mode', () => {
  const parsed = parseFastSupport(status());
  assert.equal(canEnableFast(parsed, config, 'pro'), true);
  assert.equal(canEnableFast(parsed, { ...config, mode: 'auto' }, 'pro'), true);
  assert.equal(canEnableFast(parsed, { ...config, pro_model: 'different' }, 'pro'), false);
  assert.equal(canEnableFast(parsed, { ...config, pro_provider: 'openrouter' }, 'pro'), false);
  assert.equal(canEnableFast(parsed, { ...config, mode: 'standalone' }, 'pro'), false);
  assert.equal(canEnableFast(parsed, config, 'flash'), false);
  assert.equal(canEnableFast(parsed, null, 'pro'), false);
});

test('Fast request, server acknowledgment, downgrade and unknown stay separate', () => {
  assert.equal(fastObservation({ fast_mode_requested: true }), 'requested');
  assert.equal(fastObservation({ fast_mode_requested: true, response_service_tier: null }), 'requested');
  for (const value of ['priority', 'fast']) {
    assert.equal(fastObservation({ fast_mode_requested: true, response_service_tier: value }), 'confirmed');
  }
  assert.equal(fastObservation({ fast_mode_requested: true, response_service_tier: 'default' }), 'standard');
  assert.equal(fastObservation({ fast_mode_requested: true, response_service_tier: 'auto' }), 'other');
  assert.equal(fastObservation({ fast_mode_requested: false, response_service_tier: 'priority' }), 'none');
  assert.equal(fastObservation({ cost: { serviceTier: 'priority' } }), 'none');
});
