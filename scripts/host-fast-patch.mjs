#!/usr/bin/env node
// Standalone, offline applicator. No git repository, installer, or dependencies required.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const VERSION = '0.2.1-alpha.2';
const DEFAULT_BUNDLE = fileURLToPath(new URL('../host-compat/fast-mode/', import.meta.url));
const USAGE = 'Usage: node scripts/host-fast-patch.mjs [check|apply|revert] <host-root> [--bundle <bundle-root>]\nOmitting the action performs read-only check.';
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = (message) => { throw new Error(message); };
const ownKeys = (value, keys) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const decode = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

function parseArgs(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  let action = 'check';
  if (['check', 'apply', 'revert'].includes(args[0])) action = args.shift();
  const root = args.shift();
  if (!root || root.startsWith('-')) fail(USAGE);
  let bundle = DEFAULT_BUNDLE;
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--bundle' || !args[1]) fail(USAGE);
    bundle = args[1];
  }
  return { action, root, bundle };
}

function validatePath(value) {
  if (typeof value !== 'string' || !value || /[\s\\\x00-\x1f\x7f:]/u.test(value)
      || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) fail(`Unsafe manifest path: ${JSON.stringify(value)}`);
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    fail(`Unsafe manifest path: ${value}`);
  }
  return value;
}

function regularBytes(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`Not a regular, non-symlink file: ${filename}`);
  return fs.readFileSync(filename);
}

function loadBundle(bundle) {
  const directory = fs.realpathSync(path.resolve(bundle));
  if (!fs.statSync(directory).isDirectory()) fail('Bundle root must be a directory');
  const manifest = JSON.parse(decode(regularBytes(path.join(directory, 'manifest.json'))));
  if (!ownKeys(manifest, ['format', 'hostVersion', 'files']) || manifest.format !== 1
      || manifest.hostVersion !== VERSION || !Array.isArray(manifest.files)
      || !manifest.files.length || manifest.files.length > 10000) fail('Malformed or unsupported manifest');
  const seen = new Set();
  const aliases = new Set();
  const alias = (name) => name.normalize('NFD').toLowerCase();
  for (const file of manifest.files) {
    if (!ownKeys(file, ['path', 'beforeSha256', 'afterSha256'])) fail('Malformed manifest file entry');
    validatePath(file.path);
    if (aliases.has(alias(file.path))) fail(`Duplicate manifest path (including case/Unicode aliases): ${file.path}`);
    seen.add(file.path);
    aliases.add(alias(file.path));
    if (!(file.beforeSha256 === null || (typeof file.beforeSha256 === 'string' && /^[a-f0-9]{64}$/.test(file.beforeSha256)))
        || typeof file.afterSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.afterSha256)
        || file.beforeSha256 === file.afterSha256) fail(`Malformed file hashes: ${file.path}`);
  }
  // An ancestor file can never safely coexist with a descendant target.
  for (const name of seen) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (aliases.has(alias(parts.slice(0, i).join('/')))) fail(`Overlapping manifest paths: ${name}`);
    }
  }
  const patch = regularBytes(path.join(directory, 'host.patch'));
  parsePatch(decode(patch), manifest.files);
  return { manifest, patch };
}

// Deliberately small supported dialect: ordinary text unified diffs, optionally
// wrapped in git headers/index/new-file-mode. No renames, deletes, binary data,
// mode changes, quoting, timestamps, or trailing commands are accepted.
function parsePatch(text, files) {
  if (!text || !text.endsWith('\n') || text.includes('\0')) fail('Malformed text patch');
  const lines = text.slice(0, -1).split('\n');
  const declared = new Map(files.map((file) => [file.path, file]));
  const seen = new Set();
  let i = 0;
  while (i < lines.length) {
    let gitName;
    let newMode = false;
    if (lines[i].startsWith('diff --git ')) {
      const match = /^diff --git a\/(\S+) b\/(\S+)$/.exec(lines[i++]);
      if (!match || match[1] !== match[2]) fail('Unsupported git patch header');
      gitName = validatePath(match[1]);
      if (/^new file mode 100644$/.test(lines[i])) { newMode = true; i++; }
      if (/^index [a-f0-9]+\.\.[a-f0-9]+(?: 100644| 100755)?$/.test(lines[i])) i++;
    }
    const before = /^--- (a\/(\S+)|\/dev\/null)$/.exec(lines[i++] ?? '');
    const after = /^\+\+\+ b\/(\S+)$/.exec(lines[i++] ?? '');
    if (!before || !after) fail('Unsupported unified patch headers');
    const name = validatePath(after[1]);
    if (gitName && gitName !== name) fail('Patch headers disagree');
    if (before[2] && before[2] !== name) fail('Renames are not supported');
    if (!declared.has(name)) fail(`Undeclared patch target: ${name}`);
    if (seen.has(name)) fail(`Duplicate patch target: ${name}`);
    seen.add(name);
    const isNew = declared.get(name).beforeSha256 === null;
    if (isNew !== (before[1] === '/dev/null') || (newMode && !isNew)) fail(`Patch creation disagrees with manifest: ${name}`);
    let hunks = 0;
    let changes = 0;
    while (i < lines.length && lines[i].startsWith('@@ ')) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(lines[i++]);
      if (!hunk) fail(`Malformed patch hunk: ${name}`);
      let oldLeft = Number(hunk[2] ?? 1);
      let newLeft = Number(hunk[4] ?? 1);
      if (![hunk[1], hunk[2] ?? '1', hunk[3], hunk[4] ?? '1'].every((n) => Number.isSafeInteger(Number(n)))
          || (isNew && (Number(hunk[1]) !== 0 || oldLeft !== 0)) || (!oldLeft && !newLeft)) fail(`Invalid patch hunk ranges: ${name}`);
      hunks++;
      while (oldLeft || newLeft) {
        const line = lines[i++];
        if (typeof line !== 'string' || ![' ', '+', '-'].includes(line[0])) fail(`Malformed patch hunk body: ${name}`);
        if (line[0] !== '+') oldLeft--;
        if (line[0] !== '-') newLeft--;
        if (line[0] !== ' ') changes++;
        if (oldLeft < 0 || newLeft < 0) fail(`Patch hunk counts disagree: ${name}`);
        if (lines[i] === '\\ No newline at end of file') i++;
      }
    }
    if (!hunks || !changes) fail(`Patch target has no changes: ${name}`);
  }
  if (seen.size !== declared.size) fail('Patch targets do not exactly match manifest');
}

// Reject all symlinks, including in-root links: stricter than merely rejecting
// escaping links and avoids aliasing targets. Root itself is canonicalized once.
function safeTarget(root, relative) {
  validatePath(relative);
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(`${root}${path.sep}`)) fail(`Target escapes host root: ${relative}`);
  const parts = relative.split('/');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink()) fail(`Symlink path component: ${relative}`);
    if (i < parts.length - 1 && !stat.isDirectory()) fail(`Non-directory path component: ${relative}`);
    if (i === parts.length - 1 && !stat.isFile()) fail(`Target collision (not a regular file): ${relative}`);
  }
  return absolute;
}

function readTarget(root, file) {
  const absolute = safeTarget(root, file.path);
  try {
    const bytes = fs.readFileSync(absolute);
    return { absolute, bytes, hash: sha(bytes), mode: fs.statSync(absolute).mode & 0o777 };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { absolute, bytes: null, hash: null, mode: null };
  }
}

function preflight(root, files) {
  const snapshots = files.map((file) => readTarget(root, file));
  const original = snapshots.every((snapshot, i) => snapshot.hash === files[i].beforeSha256);
  const applied = snapshots.every((snapshot, i) => snapshot.hash === files[i].afterSha256);
  if (!original && !applied) fail('Conflicting or mixed host state: every touched file must match all original hashes or all applied hashes');
  return { state: original ? 'original' : 'applied', snapshots };
}

function gitApply(root, patch, reverse, check) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_COUNT: '0' };
  for (const name of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|CONFIG_PARAMETERS|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(name)) delete env[name];
  }
  const args = ['apply', '--no-index', '--whitespace=nowarn'];
  if (reverse) args.push('-R');
  if (check) args.push('--check');
  args.push('-');
  const result = spawnSync('git', args, { cwd: root, input: patch, env, shell: false, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`git apply${check ? ' --check' : ''}${reverse ? ' -R' : ''} failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
}

// Context applicability alone cannot prove that the patch produces the manifest's
// hashes. Exercise both directions on an isolated copy of only declared bytes,
// before any live write (including when checking an already-applied installation).
function verifySnapshot(manifest, snapshots, patch, state) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'dsh-host-fast-preflight-'));
  fs.chmodSync(directory, 0o700);
  try {
    manifest.files.forEach((file, i) => {
      if (snapshots[i].bytes === null) return;
      const absolute = safeTarget(directory, file.path);
      fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
      fs.writeFileSync(absolute, snapshots[i].bytes, { flag: 'wx', mode: snapshots[i].mode });
    });
    const reverse = state === 'applied';
    gitApply(directory, patch, reverse, true);
    gitApply(directory, patch, reverse, false);
    const opposite = preflight(directory, manifest.files);
    if (opposite.state !== (reverse ? 'original' : 'applied')) fail('Patch output SHA-256 hashes disagree with manifest');
    gitApply(directory, patch, !reverse, true);
    gitApply(directory, patch, !reverse, false);
    if (preflight(directory, manifest.files).state !== state) fail('Patch round-trip SHA-256 hashes disagree with manifest');
  } catch (error) {
    fail(`Bundle snapshot validation failed: ${error.message}`);
  } finally {
    // Remove only the exact private directory created above, after resolving and
    // checking its absolute destination. Never delete a caller-supplied path.
    const absolute = fs.realpathSync(directory);
    if (!path.isAbsolute(absolute) || absolute !== directory
        || path.dirname(absolute) !== temporaryRoot
        || !path.basename(absolute).startsWith('dsh-host-fast-preflight-')
        || fs.lstatSync(directory).isSymbolicLink()) fail('Refusing unsafe snapshot cleanup');
    fs.rmSync(absolute, { recursive: true });
  }
}

function backup(root, action, manifest, snapshots) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-host-fast-backup-'));
  fs.chmodSync(directory, 0o700);
  snapshots.forEach((snapshot, i) => {
    if (snapshot.bytes !== null) fs.writeFileSync(path.join(directory, `${i}.bin`), snapshot.bytes, { mode: 0o600, flag: 'wx' });
  });
  fs.writeFileSync(path.join(directory, 'recovery.json'), `${JSON.stringify({ format: 1, root, action, manifest, snapshots: snapshots.map((s, i) => ({ path: manifest.files[i].path, hash: s.hash, mode: s.mode, backup: s.bytes === null ? null : `${i}.bin` })) }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`Backup: ${directory}`);
  return directory;
}

function rollback(root, files, snapshots, reverse) {
  const skipped = [];
  files.forEach((file, i) => {
    try {
      const current = readTarget(root, file);
      const old = snapshots[i];
      if (current.hash === old.hash) return;
      const expected = reverse ? file.beforeSha256 : file.afterSha256;
      // Unknown output could be a user's concurrent edit: never overwrite it.
      if (current.hash !== expected) { skipped.push(file.path); return; }
      const absolute = safeTarget(root, file.path);
      if (absolute !== current.absolute || !path.isAbsolute(absolute)) fail('Deletion target validation failed');
      if (old.bytes === null) {
        // Only a patch-created file with the exact expected content is removed.
        if (file.beforeSha256 !== null || current.hash !== file.afterSha256) fail('Refusing unverified deletion');
        fs.unlinkSync(absolute);
      } else {
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        safeTarget(root, file.path);
        fs.writeFileSync(absolute, old.bytes, { mode: old.mode });
        fs.chmodSync(absolute, old.mode);
      }
    } catch { skipped.push(file.path); }
  });
  return skipped;
}

function run(args) {
  const options = parseArgs(args);
  if (options.help) { console.log(USAGE); return; }
  const root = fs.realpathSync(path.resolve(options.root));
  if (!fs.statSync(root).isDirectory() || root === path.parse(root).root) fail('Host root must be a non-filesystem-root directory');
  const { manifest, patch } = loadBundle(options.bundle);
  const { state, snapshots } = preflight(root, manifest.files);
  const reverse = options.action === 'revert';
  // Check applicable direction even for an idempotent operation.
  gitApply(root, patch, state === 'applied', true);
  verifySnapshot(manifest, snapshots, patch, state);
  if (preflight(root, manifest.files).state !== state) fail('Host changed during snapshot preflight');
  if (options.action === 'check' || (reverse ? state === 'original' : state === 'applied')) {
    console.log(`State: ${state}${options.action === 'check' ? ' (read-only check)' : ' (already in requested state; no changes)'}`);
    return;
  }
  const lock = path.join(os.tmpdir(), `dsh-host-fast-lock-${sha(Buffer.from(root))}`);
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (error) {
    if (error.code === 'EEXIST') fail(`Another patch operation or stale lock exists: ${lock}`);
    throw error;
  }
  let recovery;
  let mutationStarted = false;
  try {
    recovery = backup(root, options.action, manifest, snapshots);
    gitApply(root, patch, reverse, true);
    // Re-read every target after git --check, immediately before its write phase.
    const fresh = preflight(root, manifest.files);
    if (fresh.state !== state) fail('Host changed during preflight');
    manifest.files.forEach((file) => {
      const absolute = safeTarget(root, file.path);
      if (reverse && file.beforeSha256 === null
          && (!path.isAbsolute(absolute) || readTarget(root, file).hash !== file.afterSha256)) fail(`Refusing unverified deletion: ${file.path}`);
    });
    mutationStarted = true;
    gitApply(root, patch, reverse, false);
    const final = preflight(root, manifest.files);
    if (final.state !== (reverse ? 'original' : 'applied')) fail('Post-write SHA verification failed');
    console.log(`State: ${final.state} (${reverse ? 'reverted' : 'applied'}; all SHA-256 hashes verified)`);
  } catch (error) {
    const skipped = mutationStarted ? rollback(root, manifest.files, snapshots, reverse) : [];
    fail(`${error.message}\nRecovery backup: ${recovery ?? 'not created'}${!mutationStarted ? '\nNo patch writes were attempted' : skipped.length ? `\nRollback preserved unknown/user-changed files: ${skipped.join(', ')}` : '\nRollback restored the pre-operation content'}`);
  } finally {
    // Only our empty lock directory is removed; backups are always retained.
    fs.rmdirSync(lock);
  }
}

try { run(process.argv.slice(2)); } catch (error) {
  console.error(`host-fast-patch: ${error.message}`);
  process.exitCode = 1;
}
