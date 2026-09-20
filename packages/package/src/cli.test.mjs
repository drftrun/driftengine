/**
 * The command line, exercised the way a consumer runs it.
 *
 * `node --test` rather than vitest because the thing under test is a process: its exit code is
 * half of its contract, and a subcommand that prints the right words and exits 0 on a refusal is
 * a subcommand that would let a broken build through a script.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const run = (args, cwd, env = {}) =>
  execFileSync('npx', ['tsx', '--conditions=drift-source', CLI, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, CSC_LINK: '', WIN_CSC_LINK: '', CSC_NAME: '', ...env },
  });

function project(manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'drift-pkg-'));
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'index.html'), '<!doctype html><title>t</title>BUILD_MARKER_42');
  writeFileSync(join(dir, 'drift.package.json'), JSON.stringify(manifest));
  return dir;
}

const base = {
  id: 'dev.example.title',
  name: 'Title',
  entry: 'dist/index.html',
  backend: { webgpu: 'prefer', allowSoftwareRenderer: false },
  features: { clipExport: false, gamepad: true },
  targets: ['linux-x64'],
  steam: { appId: null },
};

test('doctor accepts a well-formed project', () => {
  assert.match(run(['doctor'], project(base)), /ok/);
});

test('doctor names the field when the manifest is wrong', () => {
  assert.throws(() => run(['doctor'], project({ ...base, id: 'Title' })), /id/);
});

/*
 * **This used to be a refusal, and the refusal was wrong.** WebGPU and clip export were rejected
 * together on Linux because the only WebGPU switch known to work also encoded canvas frames as
 * all-zero green video. `ForceEnableWebGpuInterop` does neither, so a build asking for both is an
 * ordinary build — and this test is here to catch the refusal coming back.
 */
test('doctor accepts WebGPU and clip export together on Linux', () => {
  assert.match(
    run(['doctor'], project({ ...base, features: { clipExport: true, gamepad: true } })),
    /ok: Title/,
  );
});

/*
 * The signing mode is the line somebody reads and acts on, so it is printed rather than left to
 * be discovered from an artifact that will not launch.
 */
test('doctor says how each target would be signed', () => {
  const out = run(['doctor'], project({ ...base, targets: ['mac-arm64', 'linux-x64'] }));
  assert.match(out, /mac-arm64: signing adhoc/);
  assert.match(out, /linux-x64: signing none/);
});

test('verify finds a string that is in the bundle', () => {
  assert.match(run(['verify', '--contains=BUILD_MARKER_42'], project(base)), /ok/);
});

test('verify fails when the string is absent, which is what a stale build looks like', () => {
  assert.throws(() => run(['verify', '--contains=NOT_THERE'], project(base)), /NOT_THERE/);
});

test('an unknown subcommand is a usage error rather than a silent success', () => {
  assert.throws(() => run(['frobnicate'], project(base)), /usage/);
});

/*
 * The flag that lets a game keep its packaging configuration and nothing else — no Electron and no
 * Android SDK in its own dependency tree — while the tool runs from wherever it lives.
 */
test('--project points the whole command at another directory', () => {
  const dir = project(base);
  const elsewhere = mkdtempSync(join(tmpdir(), 'drift-elsewhere-'));
  assert.match(run(['doctor', `--project=${dir}`], elsewhere), /ok: Title/);
  assert.match(run(['verify', '--contains=BUILD_MARKER_42', `--project=${dir}`], elsewhere), /ok/);
});

/*
 * **The native target needs nothing of the machine and one thing of the game.** It ships the Node
 * that runs the build, so no runtime is fetched for it; it needs the host installed in the game, and
 * the desktop shell's badge is not drawn there. All three are printed where the other targets' needs
 * are, before a build.
 */
const native = { ...base, targets: ['native-linux-x64'], native: { entry: 'src/native.mjs' } };

test('doctor names the host a native build needs, and what it will not do, and no Electron', () => {
  const out = run(['doctor'], project(native));
  assert.match(out, /native-linux-x64: signing none/);
  assert.match(out, /native-linux-x64: .*npm install @driftengine\/native-host@\d+\.\d+\.\d+/);
  assert.match(out, /native-linux-x64: no engine badge/);
  assert.doesNotMatch(out, /Electron runtime/);
});

test('doctor refuses a native build that turns WebGPU off', () => {
  const off = { ...native, backend: { webgpu: 'off', allowSoftwareRenderer: false } };
  assert.throws(() => run(['doctor'], project(off)), /WebGPU alone/);
});

/*
 * **The native bundle is made from the game's source by the build, not copied from its web build**,
 * so a fresh web build says nothing about it: the web build is under `public/` and is not looked at.
 */
test('verify looks inside the native bundle when that target is named, not at the web build in it', () => {
  const dir = project(native);
  const args = ['verify', '--contains=BUILD_MARKER_42', '--target=native-linux-x64'];
  assert.throws(() => run(args, dir), /no native build/);
  const app = join(dir, 'out', 'native-linux-x64', 'title', 'app');
  mkdirSync(join(app, 'public'), { recursive: true });
  writeFileSync(join(app, 'public', 'index.html'), 'BUILD_MARKER_42');
  writeFileSync(join(app, 'game.mjs'), 'a build from before the change');
  assert.throws(() => run(args, dir), /BUILD_MARKER_42/);
  writeFileSync(join(app, 'game.mjs'), 'BUILD_MARKER_42');
  assert.match(run(args, dir), /ok/);
});
