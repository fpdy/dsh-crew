import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/host-fast-patch.mjs', import.meta.url));
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const FILES = [
  { path: 'packages/one.txt', before: 'old\n', after: 'new\n' },
  { path: 'packages/two.txt', before: 'second\n', after: 'changed\n' },
  { path: 'packages/nested/new.txt', before: null, after: 'created\n' },
];
const PATCH = FILES.map((file) => `diff --git a/${file.path} b/${file.path}\n${file.before === null ? 'new file mode 100644\n' : ''}--- ${file.before === null ? '/dev/null' : `a/${file.path}`}\n+++ b/${file.path}\n${file.before === null ? '@@ -0,0 +1 @@' : '@@ -1 +1 @@'}\n${file.before === null ? '' : `-${file.before}`}+${file.after}`).join('');

// Cleanup is confined to verified, canonical temporary fixture/backup paths.
function removeTemp(directory, prefix) {
  const absolute = fs.realpathSync(directory);
  const temp = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(absolute), temp);
  assert.ok(path.basename(absolute).startsWith(prefix));
  fs.rmSync(absolute, { recursive: true, force: true });
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'host-fast-test-'));
  const root = path.join(directory, 'host without git');
  const bundle = path.join(directory, 'bundle');
  fs.mkdirSync(path.join(root, 'packages'), { recursive: true });
  fs.mkdirSync(bundle);
  const manifest = { format: 1, hostVersion: '0.2.1-alpha.2', files: FILES.map((file) => ({ path: file.path, beforeSha256: file.before === null ? null : sha(file.before), afterSha256: sha(file.after) })) };
  function saveManifest(value = manifest) { fs.writeFileSync(path.join(bundle, 'manifest.json'), `${JSON.stringify(value)}\n`); }
  saveManifest();
  fs.writeFileSync(path.join(bundle, 'host.patch'), PATCH);
  FILES.filter((file) => file.before !== null).forEach((file) => fs.writeFileSync(path.join(root, file.path), file.before));
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'do not touch\n');
  const backups = new Set();
  t.after(() => {
    for (const backup of backups) removeTemp(backup, 'dsh-host-fast-backup-');
    removeTemp(directory, 'host-fast-test-');
  });
  function run(action = 'check', env = {}, host = root) {
    const args = action === null ? [host] : [action, host];
    const result = spawnSync(process.execPath, [SCRIPT, ...args, '--bundle', bundle], { encoding: 'utf8', env: { ...process.env, ...env }, shell: false });
    assert.ifError(result.error);
    for (const match of result.stdout.matchAll(/^Backup: (.+)$/gm)) backups.add(match[1]);
    return { ...result, output: `${result.stdout}${result.stderr}` };
  }
  function assertState(state) {
    for (const file of FILES) {
      const expected = file[state];
      const target = path.join(root, file.path);
      if (expected === null) assert.equal(fs.existsSync(target), false, file.path);
      else assert.equal(fs.readFileSync(target, 'utf8'), expected, file.path);
    }
    assert.equal(fs.readFileSync(path.join(root, 'unrelated.txt'), 'utf8'), 'do not touch\n');
    assert.equal(fs.existsSync(path.join(root, '.git')), false);
  }
  return { directory, root, bundle, manifest, saveManifest, run, assertState, backups };
}

function success(result, pattern) {
  assert.equal(result.status, 0, result.output);
  if (pattern) assert.match(result.output, pattern);
}
function failure(result, pattern) {
  assert.equal(result.status, 1, result.output);
  if (pattern) assert.match(result.output, pattern);
}

function fakeGit(f, body) {
  const realGit = process.env.PATH.split(path.delimiter).map((directory) => path.resolve(directory, 'git')).find((candidate) => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; }
  });
  assert.ok(realGit, 'A real git executable is required');
  const bin = path.join(f.directory, 'bin');
  fs.mkdirSync(bin);
  // Staging uses genuine git; fault injection applies only to the live fixture.
  const staging = `if (process.cwd() !== ${JSON.stringify(fs.realpathSync(f.root))}) {\nconst result = require('node:child_process').spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), {input: require('node:fs').readFileSync(0), stdio:['pipe','inherit','inherit']});\nif (result.error) throw result.error;\nprocess.exit(result.status ?? 1);\n}\n`;
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}\n${staging}${body}`, { mode: 0o755 });
  return { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}

test('read-only default/check, apply, idempotence, applied check, revert and re-apply without .git', (t) => {
  const f = fixture(t);
  success(f.run(null), /State: original \(read-only check\)/);
  success(f.run('check'), /State: original/);
  f.assertState('before');
  assert.equal(f.backups.size, 0);
  success(f.run('revert'), /already in requested state/);
  success(f.run('apply'), /State: applied.*hashes verified/);
  f.assertState('after');
  const count = f.backups.size;
  success(f.run('apply'), /already in requested state/);
  success(f.run('check'), /State: applied \(read-only check\)/);
  assert.equal(f.backups.size, count);
  success(f.run('revert'), /State: original.*hashes verified/);
  f.assertState('before');
  success(f.run('revert'), /already in requested state/);
  success(f.run('apply'));
  f.assertState('after');
});

test('backup captures only declared original bytes with a recovery journal', (t) => {
  const f = fixture(t);
  success(f.run('apply'));
  const directory = [...f.backups][0];
  assert.equal(fs.readFileSync(path.join(directory, '0.bin'), 'utf8'), FILES[0].before);
  assert.equal(fs.readFileSync(path.join(directory, '1.bin'), 'utf8'), FILES[1].before);
  assert.equal(fs.existsSync(path.join(directory, '2.bin')), false);
  const journal = JSON.parse(fs.readFileSync(path.join(directory, 'recovery.json'), 'utf8'));
  assert.equal(journal.root, fs.realpathSync(f.root));
  assert.deepEqual(journal.manifest, f.manifest);
  assert.equal(journal.snapshots[2].backup, null);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
});

test('plain unified diff without git headers is supported', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.bundle, 'host.patch'), PATCH.replace(/^diff --git .*\n|^new file mode 100644\n/gm, ''));
  success(f.run('apply'));
  f.assertState('after');
  success(f.run('revert'));
  f.assertState('before');
});

test('conflict in a later touched file makes apply all-or-nothing', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, FILES[1].path), 'user change\n');
  failure(f.run('apply'), /Conflicting or mixed/);
  assert.equal(fs.readFileSync(path.join(f.root, FILES[0].path), 'utf8'), FILES[0].before);
  assert.equal(fs.readFileSync(path.join(f.root, FILES[1].path), 'utf8'), 'user change\n');
  assert.equal(fs.existsSync(path.join(f.root, FILES[2].path)), false);
  assert.equal(f.backups.size, 0);
});

test('mixed original/applied state is rejected by every action', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, FILES[0].path), FILES[0].after);
  for (const action of [null, 'check', 'apply', 'revert']) failure(f.run(action), /Conflicting or mixed/);
  assert.equal(fs.readFileSync(path.join(f.root, FILES[1].path), 'utf8'), FILES[1].before);
});

test('changed patch-created file blocks revert without deleting or reverting anything', (t) => {
  const f = fixture(t);
  success(f.run('apply'));
  fs.writeFileSync(path.join(f.root, FILES[2].path), 'user-owned edit\n');
  failure(f.run('revert'), /Conflicting or mixed/);
  assert.equal(fs.readFileSync(path.join(f.root, FILES[0].path), 'utf8'), FILES[0].after);
  assert.equal(fs.readFileSync(path.join(f.root, FILES[2].path), 'utf8'), 'user-owned edit\n');
});

test('new file collisions, including matching after bytes in otherwise-original host, are rejected', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(path.join(f.root, FILES[2].path)), { recursive: true });
  for (const bytes of ['existing user file\n', FILES[2].after]) {
    fs.writeFileSync(path.join(f.root, FILES[2].path), bytes);
    failure(f.run('apply'), /Conflicting or mixed/);
    assert.equal(fs.readFileSync(path.join(f.root, FILES[0].path), 'utf8'), FILES[0].before);
    assert.equal(fs.readFileSync(path.join(f.root, FILES[2].path), 'utf8'), bytes);
  }
});

test('directory at a new-file target is rejected', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, FILES[2].path), { recursive: true });
  failure(f.run('apply'), /Target collision/);
  assert.equal(fs.readFileSync(path.join(f.root, FILES[0].path), 'utf8'), FILES[0].before);
});

test('traversal, absolute, Windows, .git, and ambiguous paths are rejected', (t) => {
  const f = fixture(t);
  for (const unsafe of ['../outside.txt', '/tmp/outside.txt', 'packages/../outside.txt', 'C:\\outside.txt', '.git/config', 'packages//one.txt', './packages/one.txt', 'packages/one file.txt']) {
    const manifest = structuredClone(f.manifest);
    manifest.files[0].path = unsafe;
    f.saveManifest(manifest);
    failure(f.run('apply'), /Unsafe manifest path/);
    f.assertState('before');
  }
});

test('symlink ancestors escaping root are rejected without reading or writing their targets', (t) => {
  const f = fixture(t);
  const outside = path.join(f.directory, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'new.txt'), 'outside sentinel\n');
  fs.symlinkSync(outside, path.join(f.root, 'packages', 'nested'), 'dir');
  failure(f.run('apply'), /Symlink path component/);
  assert.equal(fs.readFileSync(path.join(outside, 'new.txt'), 'utf8'), 'outside sentinel\n');
  assert.equal(fs.readFileSync(path.join(f.root, FILES[0].path), 'utf8'), FILES[0].before);
});

test('symlink file targets are rejected even when they point inside root', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'packages', 'nested'));
  fs.symlinkSync('../one.txt', path.join(f.root, FILES[2].path));
  failure(f.run('apply'), /Symlink path component/);
  assert.equal(fs.readFileSync(path.join(f.root, FILES[0].path), 'utf8'), FILES[0].before);
});

test('malformed, unsupported and duplicate manifest entries fail before writes', (t) => {
  const f = fixture(t);
  const malformed = [
    { ...f.manifest, format: 2 }, { ...f.manifest, hostVersion: 'other' },
    { ...f.manifest, files: [] }, { ...f.manifest, surprise: true },
    { ...f.manifest, files: [...f.manifest.files, f.manifest.files[0]] },
    { ...f.manifest, files: [{ ...f.manifest.files[0], beforeSha256: 'bad' }] },
    { ...f.manifest, files: [{ ...f.manifest.files[0], afterSha256: null }] },
    { ...f.manifest, files: [{ ...f.manifest.files[0], executable: true }] },
  ];
  for (const manifest of malformed) {
    f.saveManifest(manifest);
    failure(f.run('apply'), /Malformed|unsupported|Duplicate/);
    f.assertState('before');
  }
  fs.writeFileSync(path.join(f.bundle, 'manifest.json'), '{broken');
  failure(f.run('apply'));
  f.assertState('before');
});

test('extra patch targets and duplicate patch sections are rejected', (t) => {
  const f = fixture(t);
  const extra = 'diff --git a/extra.txt b/extra.txt\n--- /dev/null\n+++ b/extra.txt\n@@ -0,0 +1 @@\n+surprise\n';
  fs.writeFileSync(path.join(f.bundle, 'host.patch'), PATCH + extra);
  failure(f.run('apply'), /Undeclared patch target/);
  assert.equal(fs.existsSync(path.join(f.root, 'extra.txt')), false);
  f.assertState('before');
  fs.writeFileSync(path.join(f.bundle, 'host.patch'), PATCH + PATCH);
  failure(f.run('apply'), /Duplicate patch target/);
  f.assertState('before');
});

test('missing targets, creation mismatch, invalid hunks, mode changes and malformed headers fail closed', (t) => {
  const f = fixture(t);
  const badPatches = [
    PATCH.slice(0, PATCH.indexOf('diff --git a/packages/two')),
    PATCH.replace('--- /dev/null', '--- a/packages/nested/new.txt'),
    PATCH.replace('@@ -1 +1 @@', '@@ -1,2 +1 @@'),
    PATCH.replace('diff --git a/packages/one.txt b/packages/one.txt\n', 'diff --git a/packages/one.txt b/packages/one.txt\nold mode 100644\nnew mode 100755\n'),
    PATCH.replace('+++ b/packages/one.txt', '+++ b/../outside.txt'),
    PATCH + 'arbitrary trailing content\n',
  ];
  for (const patch of badPatches) {
    fs.writeFileSync(path.join(f.bundle, 'host.patch'), patch);
    failure(f.run('apply'));
    f.assertState('before');
  }
});

test('git apply --check rejects nonapplicable content before any writes', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.bundle, 'host.patch'), PATCH.replace('-second\n', '-wrong context\n'));
  failure(f.run('apply'), /git apply --check failed/);
  f.assertState('before');
  assert.equal(f.backups.size, 0);
});

test('wrong afterSHA is rejected in snapshot preflight with every live file unchanged', (t) => {
  const f = fixture(t);
  const manifest = structuredClone(f.manifest);
  manifest.files[0].afterSha256 = sha('not the patch output\n');
  f.saveManifest(manifest);
  for (const action of [null, 'check', 'apply', 'revert']) {
    failure(f.run(action), /Bundle snapshot validation failed/);
    f.assertState('before');
  }
  assert.equal(f.backups.size, 0);
});

test('wrong beforeSHA rejects reverse snapshot preflight without reverting or deleting live files', (t) => {
  const f = fixture(t);
  success(f.run('apply'));
  const manifest = structuredClone(f.manifest);
  manifest.files[1].beforeSha256 = sha('not the reverse patch output\n');
  f.saveManifest(manifest);
  const count = f.backups.size;
  for (const action of [null, 'check', 'apply', 'revert']) {
    failure(f.run(action), /Bundle snapshot validation failed/);
    f.assertState('after');
  }
  assert.equal(f.backups.size, count);
});

test('partial git failure rolls back known outputs and preserves concurrent user edits', (t) => {
  const f = fixture(t);
  const env = fakeGit(f, `const fs = require('node:fs');\nif (process.argv.includes('--check')) process.exit(0);\nfs.writeFileSync('packages/one.txt', 'new\\n');\nfs.writeFileSync('packages/two.txt', 'concurrent user edit\\n');\nfs.mkdirSync('packages/nested', {recursive:true});\nfs.writeFileSync('packages/nested/new.txt', 'created\\n');\nprocess.exit(1);\n`);
  failure(f.run('apply', env), /Rollback preserved unknown\/user-changed files: packages\/two.txt/);
  assert.equal(fs.readFileSync(path.join(f.root, FILES[0].path), 'utf8'), FILES[0].before);
  assert.equal(fs.readFileSync(path.join(f.root, FILES[1].path), 'utf8'), 'concurrent user edit\n');
  assert.equal(fs.existsSync(path.join(f.root, FILES[2].path)), false);
});

test('recheck detects edits during git --check and does not run rollback before patch writes', (t) => {
  const f = fixture(t);
  const env = fakeGit(f, `const fs = require('node:fs');\nif (!process.argv.includes('--check')) { fs.writeFileSync('unexpected-write', 'bad'); process.exit(1); }\nconst count = fs.existsSync('check-count') ? Number(fs.readFileSync('check-count')) : 0;\nfs.writeFileSync('check-count', String(count + 1));\nif (count === 1) fs.writeFileSync('packages/one.txt', 'new\\n');\nprocess.exit(0);\n`);
  failure(f.run('apply', env), /No patch writes were attempted/);
  assert.equal(fs.readFileSync(path.join(f.root, FILES[0].path), 'utf8'), FILES[0].after);
  assert.equal(fs.readFileSync(path.join(f.root, FILES[1].path), 'utf8'), FILES[1].before);
  assert.equal(fs.existsSync(path.join(f.root, 'unexpected-write')), false);
});

test('canonical host-root symlink is allowed but no traversal through target components', (t) => {
  const f = fixture(t);
  const alias = path.join(f.directory, 'host-alias');
  fs.symlinkSync(f.root, alias, 'dir');
  success(f.run('apply', {}, alias));
  f.assertState('after');
  success(f.run('revert', {}, alias));
  f.assertState('before');
});

test('no-final-newline markers preserve exact bytes through apply and revert', (t) => {
  const f = fixture(t);
  const manifest = structuredClone(f.manifest);
  manifest.files[0].beforeSha256 = sha('old');
  manifest.files[0].afterSha256 = sha('new');
  f.saveManifest(manifest);
  fs.writeFileSync(path.join(f.root, FILES[0].path), 'old');
  fs.writeFileSync(path.join(f.bundle, 'host.patch'), PATCH.replace('-old\n+new\n', '-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n'));
  success(f.run('apply'));
  assert.equal(fs.readFileSync(path.join(f.root, FILES[0].path), 'utf8'), 'new');
  success(f.run('revert'));
  assert.equal(fs.readFileSync(path.join(f.root, FILES[0].path), 'utf8'), 'old');
});

test('case aliases and ancestor/descendant manifest targets are rejected', (t) => {
  const f = fixture(t);
  for (const alias of ['PACKAGES/ONE.TXT', 'packages/one.txt/child']) {
    const manifest = structuredClone(f.manifest);
    manifest.files.push({ ...manifest.files[0], path: alias });
    f.saveManifest(manifest);
    failure(f.run('apply'), /Duplicate|Overlapping/);
    f.assertState('before');
  }
});

test('partial revert failure restores known reverted bytes and deleted patch-created files', (t) => {
  const f = fixture(t);
  success(f.run('apply'));
  const env = fakeGit(f, `const fs = require('node:fs');\nif (process.argv.includes('--check')) process.exit(0);\nfs.writeFileSync('packages/one.txt', 'old\\n');\nfs.unlinkSync('packages/nested/new.txt');\nprocess.exit(1);\n`);
  failure(f.run('revert', env), /Rollback restored the pre-operation content/);
  f.assertState('after');
});

test('symlink bundle artifacts cannot redirect manifest or patch reads', (t) => {
  const f = fixture(t);
  const target = path.join(f.directory, 'other.patch');
  fs.writeFileSync(target, PATCH);
  const patchPath = path.join(fs.realpathSync(f.bundle), 'host.patch');
  assert.equal(path.dirname(patchPath), fs.realpathSync(f.bundle));
  fs.unlinkSync(patchPath);
  fs.symlinkSync(target, patchPath);
  failure(f.run('apply'), /Not a regular, non-symlink file/);
  f.assertState('before');
});

test('CLI usage is explicit and help does not touch a host', () => {
  for (const args of [[], ['apply'], ['--bundle', '/tmp']]) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    failure({ ...result, output: result.stdout + result.stderr }, /Usage:/);
  }
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  success({ ...help, output: help.stdout + help.stderr }, /Omitting the action performs read-only check/);
});
