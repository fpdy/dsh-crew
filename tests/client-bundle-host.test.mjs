// Validate the shipped client wrapper with the built host's React, offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const anchor = process.env.DSH_HOST_ANCHOR;
test('built client loads, registers its settings section and renders the unverified-Host notice', {
  skip: !anchor && 'Set DSH_HOST_ANCHOR to test with a built host React',
}, (t) => {
  const require = createRequire(anchor);
  const React = require('react');
  const { renderToString } = require('react-dom/server');
  let client, section;
  const cleanups = [];
  const localStorage = { getItem: () => null, setItem: () => {} };
  const sandbox = {
    window: { localStorage, __ModuleLoader__: { load({ id, factory }) {
      assert.equal(id, '@zseven-w/dsh-crew');
      client = factory((name) => {
        assert(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'].includes(name));
        return require(name);
      });
    } } },
    localStorage,
    document: { visibilityState: 'hidden' },
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: () => { throw new Error('client fixture must not fetch'); },
  };
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox);
  assert.deepEqual(Array.from(client.inject), ['slots', 'locale']);
  client.apply({
    locale: { getLocale: () => ({ active: 'en' }) },
    on: () => () => {},
    slots: {
      inject(name, fn) { assert.equal(name, 'settings.section'); cleanups.push(fn()); },
      register(metadata, component) {
        assert.equal(metadata.id, 'dsh-crew');
        assert.equal(metadata.label(), 'DSH Crew');
        section = component;
        return () => {};
      },
    },
  });
  t.after(() => cleanups.forEach((dispose) => dispose()));
  assert.equal(typeof section, 'function');
  const html = renderToString(React.createElement(section));
  assert.match(html, /safety guard has not been confirmed/);
  assert.match(html, /Restart DSH after updating Crew/);
  assert(!html.includes('pasted-image transcription and generate_image all use'));
});
