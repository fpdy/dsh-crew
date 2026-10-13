// Optional offline middleware contracts against a built Host. Fast runtime
// metadata/prepare validation belongs to the Host tests; an old built Host is
// not evidence of priority support. No model calls, credentials or rebuilds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installModelSelection } from '../src/hub/index.mjs';
import { terminalResponseServiceTier } from '../src/fast-mode.mjs';
const anchor = process.env.DSH_HOST_ANCHOR;
const skip = !anchor && 'Set DSH_HOST_ANCHOR to run built Host middleware contracts';

for (const order of ['before Crew', 'after Crew']) {
  test(`real Host: Crew Fast wraps native preset controls installed ${order}`, { skip }, async t => {
    assert(isAbsolute(anchor)); const require = createRequire(anchor);
    const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
    const ctx = new Context(); t.after(() => ctx.fiber.dispose());
    const sibling = new Context(); t.after(() => sibling.fiber.dispose());
    const preset = async (_payload, next) => ({ ...await next(), provider: 'preset-native', model: 'native', serviceTier: 'priority', temperature: 0.5 });
    if (order === 'before Crew') ctx.on('agent/request', preset);
    const selection = { current: { provider: 'openai-codex', model: 'crew-fixture', fast_mode: false, reasoningEffort: 'max' } };
    installModelSelection(ctx, selection);
    if (order === 'after Crew') ctx.on('agent/request', preset);
    const image = Object.freeze({ type: 'image', attachment: Object.freeze({ id: 'offline', name: 'native.png' }) });
    const seed = Object.freeze({ provider: 'seed', model: 'seed', serviceTier: 'priority', maxTokens: 321,
      messages: Object.freeze([{ role: 'user', content: Object.freeze([image]) }]), stop: Object.freeze(['END']) });
    for (const fastMode of [false, true]) {
      selection.current = { ...selection.current, fast_mode: fastMode };
      await ctx.waterfall('system-prompt/assemble', {}, {}, async () => ({ variables: {} }));
      const result = await ctx.waterfall('agent/request', {}, async () => seed);
      assert.equal(result.provider, 'openai-codex'); assert.equal(result.model, 'crew-fixture');
      assert.equal(result.reasoningEffort, 'max'); assert.equal(Object.hasOwn(result, 'serviceTier'), fastMode);
      if (fastMode) assert.equal(result.serviceTier, 'priority');
      assert.equal(result.messages, seed.messages); assert.equal(result.messages[0].content[0], image);
      assert.equal(result.stop, seed.stop); assert.equal(result.maxTokens, 321); assert.equal(result.temperature, 0.5);
      assert.equal(await sibling.waterfall('agent/request', {}, async () => seed), seed, 'other agents/native sessions remain untouched');
    }
  });
}

test('real Host: compact durable stream keeps terminal service-tier evidence', { skip }, async () => {
  const require = createRequire(anchor);
  const { AssistantStreamAccumulator } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));
  const stream = new AssistantStreamAccumulator();
  stream.push({ time: 1, chunk: { type: 'text-delta', index: 0, text: 'offline' } });
  stream.push({ time: 2, chunk: { type: 'finish', reason: { kind: 'stop' }, responseServiceTier: 'priority' } });
  assert.equal(terminalResponseServiceTier(stream.snapshot()), 'priority');
});
