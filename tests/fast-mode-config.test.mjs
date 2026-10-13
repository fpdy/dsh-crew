import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const installUrl = new URL('../src/install/install.mjs', import.meta.url).href;
test('global defaults, strict Fast parser/patches and legacy-key preservation in isolated home', () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-fast-config-'));
  const file = join(home, '.config/dsh-crew/config.json');
  mkdirSync(join(home, '.config/dsh-crew'), { recursive: true });
  writeFileSync(file, JSON.stringify({ pro_provider: 'custom', legacy_future_setting: { keep: true }, default_effort: 'high' }));
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { readFileSync, writeFileSync, chmodSync, rmSync, mkdirSync } from 'node:fs';
      const { readGlobalConfig, writeGlobalConfig } = await import(${JSON.stringify(installUrl)});
      const file = ${JSON.stringify(file)};
      const original = readFileSync(file, 'utf8');
      const first = readGlobalConfig();
      assert.equal(first.pro_fast_mode, false); assert.equal(first.flash_fast_mode, false);
      for (const value of [null, 0, 1, 'true', 'false', {}, []]) {
        assert.throws(() => writeGlobalConfig({ pro_fast_mode: value, default_effort: 'max' }), /boolean/);
        assert.equal(readFileSync(file, 'utf8'), original, 'invalid patch must be atomic');
      }
      const next = writeGlobalConfig({ pro_fast_mode: true, flash_fast_mode: false });
      assert.equal(next.pro_provider, 'custom'); assert.equal(next.default_effort, 'high');
      assert.deepEqual(next.legacy_future_setting, { keep: true });
      assert.equal(readGlobalConfig().pro_fast_mode, true);
      writeFileSync(file, JSON.stringify({ flash_fast_mode: 'false' }));
      assert.throws(readGlobalConfig, /flash_fast_mode must be a boolean/);
      for (const raw of ['{"pro_fast_mode":', '[]', 'null', 'true', '42', JSON.stringify({ flash_fast_mode: 'false' })]) {
        writeFileSync(file, raw);
        assert.throws(readGlobalConfig, /valid JSON|JSON object|boolean/);
        assert.throws(() => writeGlobalConfig({ pro_fast_mode: false }), /valid JSON|JSON object|boolean/);
        assert.equal(readFileSync(file, 'utf8'), raw, 'malformed/schema-invalid settings must not be overwritten');
      }
      writeFileSync(file, original);
      if (process.platform !== 'win32' && process.getuid?.() !== 0) {
        chmodSync(file, 0o000);
        try {
          assert.throws(readGlobalConfig, { code: 'EACCES' });
          assert.throws(() => writeGlobalConfig({ pro_fast_mode: false }), { code: 'EACCES' });
        } finally { chmodSync(file, 0o600); }
        assert.equal(readFileSync(file, 'utf8'), original, 'unreadable settings must not be overwritten');
      }
      rmSync(file);
      assert.equal(readGlobalConfig().pro_fast_mode, false, 'only absent file restores defaults');
      mkdirSync(file);
      assert.throws(readGlobalConfig);
      assert.throws(() => writeGlobalConfig({ pro_fast_mode: false }));
    `], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } finally {
    assert(home.startsWith(join(tmpdir(), 'crew-fast-config-')));
    rmSync(home, { recursive: true, force: true });
  }
});
